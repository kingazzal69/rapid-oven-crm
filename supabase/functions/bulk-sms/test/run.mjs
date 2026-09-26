// Runs the real bulk-sms Edge Function against an in-memory database and a stubbed
// n8n/MobileMessage endpoint. Nothing external is contacted and no SMS is sent.
//   node supabase/functions/bulk-sms/test/run.mjs
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createDb } from "./fake-supabase.mjs";
import { loadHandler, TEST_ENV as env, jwt } from "./load-function.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const handler = await loadHandler();

// ---- the CRM page's own personalisation, for parity checks ----
const page = readFileSync(join(repo, "index.html"), "utf8");
function grab(name) {
  const start = page.indexOf(`function ${name}(`);
  let depth = 0, quote = null;
  for (let i = page.indexOf("{", start); i < page.length; i++) {
    const c = page[i];
    if (c === "\\") { i++; continue; }
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "{") depth++;
    if (c === "}" && --depth === 0) return page.slice(start, i + 1);
  }
  throw new Error("could not extract " + name);
}
const pagePersonalise = new Function(`${grab("fmtD")}\n${grab("fmtTime12")}\n${grab("firstNameOf")}\n${grab("personaliseSmsText")}\nreturn personaliseSmsText;`)();

// ---- fixtures ----
const TOK = { good: jwt({ aal: "aal2", n: 1 }), aal1: jwt({ aal: "aal1" }), other: jwt({ aal: "aal2", n: 2 }), expired: jwt({ aal: "aal2", n: 3 }) };
globalThis.__fakeUsers = {
  [TOK.good]: { email: "Aaron@Example.com" },
  [TOK.aal1]: { email: "aaron@example.com" },
  [TOK.other]: { email: "mallory@example.com" },
};
const LEADS = {
  L1: { name: "Bowman, Trudy", phone: "0412 345 678", service: "Oven Clean", value: 1200, suburb: "Ryde", jobDate: "2026-10-05", jobTime: "09:30" },
  L2: { name: "Sam Lee", phone: "+61 412 345 678", service: "BBQ Clean" },
  L3: { name: "Jo Park", phone: "61498765432" },
  L4: { name: "No Phone", phone: "" },
  L5: { name: "Landline Larry", phone: "02 9876 5432" },
  L6: { name: "Opted Out", phone: "0400 000 001" },
  L7: { name: "Park, Jo", phone: "(0498) 765-432" },
  L8: { name: "Old Customer", phone: "411111111", archived: true },
};
const TEMPLATE = "Hi {name}, Brenna from Rapid Oven Cleaning here re your {service}{value}{jobwhen} in {suburb}.";
const seed = () => ({
  leads: Object.entries(LEADS).map(([id, data]) => ({ id, data })),
  bulk_sms_suppressions: [{ canonical_number: "61400000001", reason: "manual", created_by: "aaron@example.com" }],
});

let provider;
function stubProvider(mode = "accept") {
  provider = { calls: [], mode };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    provider.calls.push({ url, headers: init.headers, body });
    await new Promise((r) => setTimeout(r, 5));
    const m = provider.mode;
    if (m === "throw") throw Object.assign(new Error("aborted"), { name: "AbortError" });
    if (m === "500") return new Response("oops", { status: 500 });
    if (m === "malformed") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    const results = body.messages.map((msg, i) => {
      if (m === "mixed") return i === 0 ? { operation_id: msg.operation_id, status: "accepted", provider_message_id: "mm1" } : i === 1 ? { operation_id: msg.operation_id, status: "confirmed_failed" } : null;
      return { operation_id: msg.operation_id, status: "accepted", provider_message_id: "mm" + i };
    }).filter(Boolean);
    if (m === "foreign") results.push({ operation_id: "someone-else:61400000009", status: "accepted" });
    return new Response(JSON.stringify({ results }), { status: 200 });
  };
}

async function call(action, body = {}, { token = TOK.good, origin = env.CRM_ORIGIN } = {}) {
  const headers = { "Content-Type": "application/json", Origin: origin };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await handler(new Request("https://fn.example/bulk-sms", { method: "POST", headers, body: JSON.stringify({ action, ...body }) }));
  return { status: res.status, body: await res.json() };
}
const fresh = (extra = {}) => { const s = seed(); for (const [k, v] of Object.entries(extra)) s[k] = (s[k] ?? []).concat(v); globalThis.__fakeDb = createDb(s); stubProvider(); return globalThis.__fakeDb; };
const req = (key, leadIds, text = TEMPLATE) => ({ client_batch_key: key, lead_ids: leadIds, template_text: text, template_name: "Test" });
const VALID = ["L1", "L2", "L3", "L6", "L7", "L8"];
const PICK = (prep) => Object.fromEntries(prep.conflicts.map((c) => [c.canonical_number, c.messages[0]]));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("rejects missing, expired, unauthorised, no-2FA and wrong-origin callers", async () => {
  fresh();
  assert.equal((await call("templates.list", {}, { token: null })).status, 401);
  assert.equal((await call("templates.list", {}, { token: TOK.expired })).status, 401);
  assert.equal((await call("templates.list", {}, { token: TOK.other })).status, 403);
  const noMfa = await call("templates.list", {}, { token: TOK.aal1 });
  assert.equal(noMfa.status, 401);
  assert.equal(noMfa.body.code, "mfa_required");
  assert.equal((await call("templates.list", {}, { origin: "https://evil.example" })).status, 403);
  assert.equal(globalThis.__fakeDb.tables.bulk_sms_templates.length, 0);
});

test("bulk templates seed once from quick-SMS copies and save independently", async () => {
  const db = fresh();
  const quick = [{ name: "A", text: "Hi {name}" }, { name: "B", text: "Bye {name}" }];
  const [a, b] = await Promise.all([call("templates.list", { seed_from: quick }), call("templates.list", { seed_from: quick })]);
  assert.equal(db.tables.bulk_sms_templates.length, 2, "concurrent first loads seed only once");
  const t = (a.body.templates.length ? a : b).body.templates[0];
  assert.equal((await call("templates.save", { id: t.id, text: "Edited {name}" })).status, 200);
  const again = await call("templates.list", { seed_from: [{ name: "Z", text: "new" }] });
  assert.deepEqual(again.body.templates.map((x) => x.text), ["Edited {name}", "Bye {name}"]);
  assert.equal(quick[0].text, "Hi {name}", "the quick-SMS source list is never modified");
  assert.equal((await call("templates.save", { id: "nope", text: "x" })).status, 404);
});

test("prepare resolves numbers, merges duplicates, flags conflicts, invalid and opted-out", async () => {
  fresh();
  const r = await call("prepare", req("k1", [...Object.keys(LEADS), "L9", "L1"]));
  assert.equal(r.status, 200);
  const p = r.body;
  assert.equal(p.selected_count, 9, "duplicate ticks of the same id count once");
  assert.deepEqual(p.recipients.map((x) => x.canonical_number).sort(), ["61411111111", "61412345678", "61498765432"]);
  assert.deepEqual(p.recipients.find((x) => x.canonical_number === "61412345678").lead_ids, ["L1", "L2"]);
  assert.deepEqual(p.recipients.find((x) => x.canonical_number === "61498765432").lead_ids, ["L3", "L7"]);
  assert.deepEqual(p.conflicts.map((c) => c.canonical_number), ["61412345678"], "Trudy and Sam share a number but get different messages");
  assert.equal(p.recipients.find((x) => x.canonical_number === "61498765432").message.startsWith("Hi Jo,"), true, "'Park, Jo' and 'Jo Park' both greet Jo, so they merge without a conflict");
  assert.deepEqual(p.invalid.map((x) => x.lead_id).sort(), ["L4", "L5", "L9"]);
  assert.deepEqual(p.suppressed.map((x) => x.lead_id), ["L6"]);
});

test("server messages match the CRM page's preview exactly", async () => {
  fresh();
  const p = (await call("prepare", req("k1", ["L1", "L3", "L8"]))).body;
  for (const id of ["L1", "L3", "L8"]) {
    const expected = pagePersonalise(LEADS[id], TEMPLATE);
    const got = p.recipients.find((x) => x.lead_ids.includes(id)).message;
    assert.equal(got, expected, `message for ${id}`);
  }
  assert.equal(pagePersonalise(LEADS.L1, TEMPLATE), "Hi Trudy, Brenna from Rapid Oven Cleaning here re your oven clean ($1,200) for 5 Oct at 9:30am in Ryde.");
});

test("submit is blocked while anything needs fixing, and sends nothing", async () => {
  fresh();
  const p = (await call("prepare", req("k1", ["L1", "L4"]))).body;
  const r = await call("submit", { ...req("k1", ["L1", "L4"]), payload_hash: p.payload_hash });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "invalid_recipients");
  const p2 = (await call("prepare", req("k2", ["L1", "L2"]))).body;
  const r2 = await call("submit", { ...req("k2", ["L1", "L2"]), payload_hash: p2.payload_hash });
  assert.equal(r2.body.code, "conflict_unresolved");
  const r3 = await call("submit", { ...req("k2", ["L1", "L2"]), payload_hash: p2.payload_hash, conflict_choices: { "61412345678": "made-up text" } });
  assert.equal(r3.body.code, "conflict_unresolved", "a choice must be one of the offered messages");
  assert.equal(provider.calls.length, 0);
});

test("a normal send goes out once, with the chosen message, and reports who to untick", async () => {
  const db = fresh();
  const p = (await call("prepare", req("k1", VALID))).body;
  const choice = p.conflicts[0].messages[1];
  const r = await call("submit", { ...req("k1", VALID), payload_hash: p.payload_hash, conflict_choices: { "61412345678": choice } });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "accepted");
  assert.equal(provider.calls.length, 1);
  const sent = provider.calls[0];
  assert.equal(sent.headers["X-CRM-SMS-Secret"], "test-secret");
  assert.equal(sent.body.messages.length, 3, "L6 opted out; L1/L2 and L3/L7 share numbers");
  assert.equal(sent.body.messages.find((m) => m.to === "61412345678").message, choice);
  assert.deepEqual(r.body.accepted_lead_ids.sort(), ["L1", "L2", "L3", "L7", "L8"]);
  assert.equal(r.body.accepted_count, 3);
  assert.ok(db.tables.bulk_sms_recipients.every((x) => x.status === "accepted" && x.provider_message_id));
});

test("sending the same batch again never sends twice", async () => {
  fresh();
  const p = (await call("prepare", req("k1", ["L3"]))).body;
  const body = { ...req("k1", ["L3"]), payload_hash: p.payload_hash };
  await call("submit", body);
  const again = await call("submit", body);
  assert.equal(again.body.already_submitted, true);
  assert.equal(provider.calls.length, 1);
  const reprep = await call("prepare", req("k1", ["L3"]));
  assert.equal(reprep.body.code, "batch_used", "a used batch key can't be re-prepared into a second send");
});

test("double-click / two tabs: concurrent submits send exactly once", async () => {
  fresh();
  const p = (await call("prepare", req("k1", ["L3", "L8"]))).body;
  const body = { ...req("k1", ["L3", "L8"]), payload_hash: p.payload_hash };
  const results = await Promise.all([call("submit", body), call("submit", body), call("submit", body)]);
  assert.equal(provider.calls.length, 1);
  assert.equal(results.filter((r) => r.body.already_submitted).length, 2);
});

test("a change after review (opt-out added) forces a fresh review", async () => {
  fresh();
  const p = (await call("prepare", req("k1", ["L3", "L8"]))).body;
  await call("suppressions.add", { number: "0411 111 111" });
  const r = await call("submit", { ...req("k1", ["L3", "L8"]), payload_hash: p.payload_hash });
  assert.equal(r.body.code, "stale_review");
  assert.equal(provider.calls.length, 0);
});

test("a tampered request (different clients, same review) is rejected", async () => {
  fresh();
  const p = (await call("prepare", req("k1", ["L3"]))).body;
  const r = await call("submit", { ...req("k1", ["L3", "L8"]), payload_hash: p.payload_hash });
  assert.equal(r.body.code, "stale_review");
  const r2 = await call("submit", { ...req("k-never-prepared", ["L3"]), payload_hash: p.payload_hash });
  assert.equal(r2.body.code, "stale_review");
  assert.equal(provider.calls.length, 0);
});

test("mixed provider results: accepted, rejected, and unreported are kept apart", async () => {
  const db = fresh();
  provider.mode = "mixed";
  const p = (await call("prepare", req("k1", ["L3", "L8", "L1"]))).body;
  const r = await call("submit", { ...req("k1", ["L3", "L8", "L1"]), payload_hash: p.payload_hash });
  assert.equal(r.body.accepted_count, 1);
  assert.equal(r.body.confirmed_failed.length, 1);
  assert.equal(r.body.unknown.length, 1, "a recipient the workflow didn't report on is unknown, not sent");
  assert.equal(r.body.status, "unknown");
  assert.equal(r.body.accepted_lead_ids.length, 1, "only the accepted client is unticked");
  assert.equal(db.tables.bulk_sms_batches[0].status, "unknown");
});

for (const mode of ["malformed", "500", "throw"]) {
  test(`provider ${mode === "throw" ? "timeout/disconnect" : mode + " response"}: everything unknown, nothing unticked, no resend`, async () => {
    fresh();
    provider.mode = mode;
    const p = (await call("prepare", req("k1", ["L3", "L8"]))).body;
    const body = { ...req("k1", ["L3", "L8"]), payload_hash: p.payload_hash };
    const r = await call("submit", body);
    assert.equal(r.status, 502);
    assert.equal(r.body.unknown.length, 2);
    assert.deepEqual(r.body.accepted_lead_ids, []);
    provider.mode = "accept";
    const retry = await call("submit", body);
    assert.equal(retry.body.already_submitted, true);
    assert.equal(provider.calls.length, 1, "an uncertain send is never automatically repeated");
    const status = await call("batch.status", { client_batch_key: "k1" });
    assert.equal(status.body.status, "unknown");
  });
}

test("results for operations outside this batch are ignored", async () => {
  const db = fresh();
  provider.mode = "foreign";
  const p = (await call("prepare", req("k1", ["L3"]))).body;
  await call("submit", { ...req("k1", ["L3"]), payload_hash: p.payload_hash });
  assert.equal(db.tables.bulk_sms_recipients.length, 1);
});

test("batch.status supports recovery after a reload", async () => {
  fresh();
  assert.equal((await call("batch.status", { client_batch_key: "nope" })).body.status, "none");
  const p = (await call("prepare", req("k1", ["L3"]))).body;
  assert.equal((await call("batch.status", { client_batch_key: "k1" })).body.status, "prepared");
  await call("submit", { ...req("k1", ["L3"]), payload_hash: p.payload_hash });
  const s = (await call("batch.status", { client_batch_key: "k1" })).body;
  assert.equal(s.status, "accepted");
  assert.deepEqual(s.accepted_lead_ids, ["L3"]);
});

test("test allowlist: only listed numbers can be texted while it's set", async () => {
  fresh();
  env.SMS_TEST_ALLOWLIST = "0498 765 432";
  try {
    const p = (await call("prepare", req("k1", ["L3", "L8"]))).body;
    assert.deepEqual(p.recipients.map((r) => r.canonical_number), ["61498765432"]);
    assert.deepEqual(p.invalid.map((x) => x.lead_id), ["L8"]);
    const blocked = await call("submit", { ...req("k1", ["L3", "L8"]), payload_hash: p.payload_hash });
    assert.equal(blocked.body.code, "invalid_recipients");
    const ok = (await call("prepare", req("k2", ["L3"]))).body;
    assert.equal((await call("submit", { ...req("k2", ["L3"]), payload_hash: ok.payload_hash })).body.status, "accepted");
    assert.deepEqual(provider.calls.flatMap((c) => c.body.messages.map((m) => m.to)), ["61498765432"]);
  } finally {
    delete env.SMS_TEST_ALLOWLIST;
  }
});

test("opt-out list normalises numbers and rejects junk", async () => {
  const db = fresh();
  assert.equal((await call("suppressions.add", { number: "+61 400 000 002" })).body.canonical_number, "61400000002");
  await call("suppressions.add", { number: "0400000002" });
  assert.equal(db.tables.bulk_sms_suppressions.length, 2, "adding the same number twice is harmless");
  assert.equal((await call("suppressions.add", { number: "02 9876 5432" })).status, 400);
  await call("suppressions.remove", { number: "0400 000 002" });
  assert.equal((await call("suppressions.list")).body.suppressions.length, 1);
});

test("large lists: >1000 opt-outs and hundreds of clients are all read", async () => {
  const many = Array.from({ length: 1500 }, (_, i) => ({ canonical_number: "6149" + String(i).padStart(7, "0"), reason: "bulk", created_by: "x" }));
  const leadsExtra = Array.from({ length: 250 }, (_, i) => ({ id: "M" + i, data: { name: "Client " + i, phone: "049" + String(i + 1200).padStart(7, "0") } }));
  fresh({ bulk_sms_suppressions: many, leads: leadsExtra });
  const ids = leadsExtra.map((l) => l.id);
  const p = (await call("prepare", req("k1", ids))).body;
  assert.equal(p.invalid.length, 0, "every client in a 250-client selection was found");
  assert.equal(p.suppressed.length, 250, "opt-outs beyond the first 1000 rows still apply");
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log("PASS", name);
  } catch (e) {
    failed++;
    console.log("FAIL", name, "\n    ", e.message);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
