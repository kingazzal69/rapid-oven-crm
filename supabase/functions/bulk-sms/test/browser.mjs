// Drives the real CRM page (index.html) in headless Chromium against the real bulk-sms
// function, with a fake database, fake sign-in/2FA, and a stubbed n8n/MobileMessage.
// The CRM has one sign-in (password + code) that also covers bulk SMS, so the page's data client is also its auth client.
// No network, no real accounts, no SMS.
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs node supabase/functions/bulk-sms/test/browser.mjs
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createDb } from "./fake-supabase.mjs";
import { loadHandler, jwt } from "./load-function.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, "..", "..", "..", "..", "index.html"), "utf8");
const handler = await loadHandler();

const TOKENS = { aal2: jwt({ aal: "aal2" }), aal1: jwt({ aal: "aal1" }) };
globalThis.__fakeUsers = { [TOKENS.aal2]: { email: "aaron@example.com" }, [TOKENS.aal1]: { email: "aaron@example.com" } };

// ---- fixtures shared by the page's data client and the server's database ----
const now = Date.UTC(2026, 8, 1);
const leadRows = [];
const add = (id, data, age) => leadRows.push({ id, data: { stage: "new", service: "Oven Clean", source: "Web", createdAt: now - age * 60000, history: [], ...data }, updated_at: new Date(now - age * 60000).toISOString() });
add("X1", { name: "Bowman, Trudy", phone: "0412 345 678" }, 1);
add("X2", { name: "Sam Lee", phone: "+61 412 345 678" }, 2);
add("X3", { name: "No Phone", phone: "" }, 3);
add("X4", { name: '<img src=x onerror="window.__xss=1">', phone: "0455 555 555" }, 4);
add("X5", { name: "Opt Out Person", phone: "0466 666 666" }, 5);
for (let i = 0; i < 250; i++) add("A" + i, { name: "Client " + String(i).padStart(3, "0"), phone: "0420" + String(i).padStart(6, "0") }, 10 + i);
add("H1", { name: "Old Customer", phone: "0477 777 777", archived: true }, 5000);
const pageFixtures = { leads: leadRows, projects: [{ id: "p1", data: { name: "Fixture project" } }], todos: [{ id: "t1", data: { text: "Fixture todo" } }] };

globalThis.__fakeDb = createDb({ leads: leadRows.map(({ id, data }) => ({ id, data })) });
const provider = { calls: [], mode: "accept", delay: 5 };
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  provider.calls.push(body);
  await new Promise((r) => setTimeout(r, provider.delay));
  if (provider.mode === "throw") throw Object.assign(new Error("aborted"), { name: "AbortError" });
  return new Response(JSON.stringify({ results: body.messages.map((m, i) => ({ operation_id: m.operation_id, status: "accepted", provider_message_id: "mm" + i })) }), { status: 200 });
};
const inflight = [];
async function invoke(_name, body, level) {
  const headers = { "Content-Type": "application/json", Origin: "https://kingazzal69.github.io" };
  if (level) headers.Authorization = "Bearer " + TOKENS[level];
  const p = handler(new Request("https://fn.example/bulk-sms", { method: "POST", headers, body: JSON.stringify(body) })).then(async (res) => ({ status: res.status, body: await res.json() }));
  inflight.push(p);
  return p;
}

// ---- browser-side stand-ins for supabase-js and Leaflet ----
const supabaseStub = `
window.__writes=[];
window.supabase={createClient(){const d=dataClient(),a=authClient();return{...d,auth:a.auth,functions:a.functions};}};
function dataClient(){
  function q(table){
    const st={archived:null,op:'select',from:0,to:1e9};
    const b={
      select(){return b},order(){return b},gte(){return b},eq(){return b},
      range(a,z){st.from=a;st.to=z;return b},
      filter(col){if(col==='data->archived')st.archived=true;return b},
      or(){st.archived=false;return b},
      upsert(v){__writes.push({table,op:'upsert'});st.op='w';return b},
      insert(v){__writes.push({table,op:'insert'});st.op='w';return b},
      update(v){__writes.push({table,op:'update'});st.op='w';return b},
      delete(){__writes.push({table,op:'delete'});st.op='w';return b},
      then(res,rej){let data=[];if(st.op==='select'){data=(__fixtures[table]||[]).filter(r=>st.archived===null||(!!(r.data&&r.data.archived))===st.archived).slice(st.from,st.to+1);}return Promise.resolve({data,error:null}).then(res,rej);}
    };
    return b;
  }
  return{from:q,channel(){const c={on(){return c},subscribe(){return c}};return c},removeChannel(){}};
}
function authClient(){
  // The shared login already has its code set up (the gate never enrols one).
  const load=()=>JSON.parse(sessionStorage.getItem('__fakeAuth')||'null')||{session:false,aal:'aal1',factor:{id:'f1',factor_type:'totp',status:'verified'}};
  const save=s=>sessionStorage.setItem('__fakeAuth',JSON.stringify(s));
  const user={email:'aaron@example.com'};
  return{
    auth:{
      async getSession(){const s=load();return{data:{session:s.session?{user}:null},error:null}},
      async signInWithPassword({password}){const s=load();if(password!=='right')return{data:{},error:{message:'Invalid login credentials'}};s.session=true;s.aal='aal1';save(s);return{data:{user},error:null}},
      async signOut(){const s=load();s.session=false;s.aal='aal1';save(s);return{error:null}},
      onAuthStateChange(){return{data:{subscription:{unsubscribe(){}}}}},
      mfa:{
        async getAuthenticatorAssuranceLevel(){return{data:{currentLevel:load().aal},error:null}},
        async listFactors(){const f=load().factor?[load().factor]:[];return{data:{all:f,totp:f.filter(x=>x.status==='verified')},error:null}},
        async unenroll({factorId}){const s=load();if(s.factor&&s.factor.id===factorId){s.factor=null;save(s);}return{error:null}},
        async enroll(){const s=load();s.factor={id:'f1',factor_type:'totp',status:'unverified'};save(s);return{data:{id:'f1',totp:{qr_code:window.__qrCode||'data:image/svg+xml;utf-8,<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',secret:'JBSWY3DPEHPK3PXP'}},error:null}},
        async challengeAndVerify({code}){const s=load();if(code!=='123456')return{error:{message:'Invalid TOTP code'}};s.factor.status='verified';s.aal='aal2';save(s);return{data:{},error:null}},
      }
    },
    functions:{async invoke(name,{body}){const s=load();const r=await window.__invokeBulkSms(name,body,s.session?s.aal:null);
      if(r.status>=200&&r.status<300)return{data:r.body,error:null};
      return{data:null,error:{message:'Edge Function returned a non-2xx status code',context:new Response(JSON.stringify(r.body),{status:r.status})}};}}
  };
}`;
const leafletStub = "window.L=new Proxy(function(){},{get:()=>window.L,apply:()=>window.L});";

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium" });
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("dialog", (d) => d.accept());
await page.exposeFunction("__invokeBulkSms", invoke);
await page.addInitScript(([fx, qr]) => { window.__fixtures = fx; window.__qrCode = qr; }, [pageFixtures, process.env.QR_DATA_URL || null]);
await page.route("**/*", (route) => {
  const url = route.request().url();
  if (url.startsWith("https://kingazzal69.github.io/rapid-oven-crm/")) return route.fulfill({ contentType: "text/html", body: indexHtml });
  if (url.includes("@supabase/supabase-js")) return route.fulfill({ contentType: "application/javascript", body: supabaseStub });
  if (url.includes("leaflet") && url.endsWith(".js")) return route.fulfill({ contentType: "application/javascript", body: leafletStub });
  return route.fulfill({ body: "" });
});

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(["PASS", name]); console.log("PASS", name); }
  catch (e) { results.push(["FAIL", name]); console.log("FAIL", name, "\n    ", e.message.split("\n")[0]); }
}
const count = () => page.locator("#bulkSmsCount").innerText();
const selected = () => page.evaluate(() => [...selectedClientIds].sort());
const search = async (text) => { await page.fill("#search", text); await page.waitForTimeout(50); };
const tick = async (id) => { await page.locator(`input.rowCheck[value="${id}"]`).check(); };
const status = () => page.locator("#bulkSmsStatus").innerText();
const visible = (sel) => page.locator(sel).isVisible();
const openModal = async () => { await page.click("#bulkSmsButton"); await page.waitForTimeout(150); };
const settle = async () => { await Promise.all(inflight); await page.waitForTimeout(150); };
const shot = async (name) => { if (process.env.SCREENSHOTS) await page.locator("#bulkSmsOverlay .modal").screenshot({ path: join(process.env.SCREENSHOTS, name + ".png") }); };

await page.goto("https://kingazzal69.github.io/rapid-oven-crm/");

await step("the CRM stays locked until the password and the code are both right", async () => {
  await page.waitForSelector("#authSignIn:not(.hide)");
  assert.equal(await page.evaluate(() => leads.length), 0, "nothing loads before sign-in");
  await page.fill("#authEmail", "aaron@example.com");
  await page.fill("#authPassword", "wrong");
  await page.click("#authSignInButton");
  await page.waitForTimeout(100);
  assert.match(await page.locator("#authStatus").innerText(), /isn.t right/);
  await page.fill("#authPassword", "right");
  await page.click("#authSignInButton");
  await page.waitForSelector("#authMfa:not(.hide)");
  assert.equal(await page.evaluate(() => leads.length), 0, "password alone loads nothing");
  await page.fill("#authCode", "000000");
  await page.click("#authVerifyButton");
  await page.waitForTimeout(100);
  assert.match(await page.locator("#authStatus").innerText(), /didn.t work/);
  await page.fill("#authCode", "123456");
  await page.click("#authVerifyButton");
  await page.waitForFunction(() => typeof leads !== "undefined" && leads.length > 200);
  assert.ok(await page.locator("#authGate").evaluate((e) => e.classList.contains("hide")));
});
await page.waitForFunction(() => typeof leads !== "undefined" && leads.length > 200);
await page.click("#nav-clients");
await page.waitForFunction(() => leads.some((l) => l.id === "H1"));
const writesAtStart = await page.evaluate(() => __writes.length);

await step("ticks survive paging, searching and reloads; header box only affects its page", async () => {
  await tick("X1");
  await page.evaluate(() => goToPage(2));
  const onPage2 = await page.locator("input.rowCheck").first().getAttribute("value");
  await tick(onPage2);
  await search("Old Customer");
  await tick("H1");
  await search("");
  assert.equal(await count(), "3 selected");
  await search("Client 01");
  const rows = await page.locator("input.rowCheck").count();
  await page.click("#selectAll");
  assert.equal(await count(), `${3 + rows} selected`);
  await page.click("#selectAll");
  assert.equal(await count(), "3 selected");
  await search("");
  await page.reload();
  await page.waitForFunction(() => typeof leads !== "undefined" && leads.length > 200);
  await page.click("#nav-clients");
  assert.equal(await count(), "3 selected");
  if (process.env.SCREENSHOTS) await page.screenshot({ path: join(process.env.SCREENSHOTS, "0-clients.png") });
  assert.deepEqual(await selected(), ["H1", "X1", onPage2].sort());
});

await step("bulk SMS opens straight to the composer: the CRM sign-in is enough", async () => {
  await openModal();
  await settle();
  assert.ok(await visible("#bulkSmsComposer"));
  assert.equal(await page.locator("#bulkSmsEmail").count(), 0, "no separate bulk SMS sign-in");
  await shot("1-compose");
  const options = await page.locator("#bulkSmsTemplate option").count();
  assert.equal(options, await page.evaluate(() => tpls.length), "bulk templates were copied from the quick-SMS ones");
});

await step("saving a bulk template leaves quick-SMS templates and config untouched", async () => {
  const before = await page.evaluate(() => JSON.stringify(tpls));
  await page.selectOption("#bulkSmsTemplate", "0");
  await page.fill("#bulkSmsText", "Hi {name}, Brenna here from Rapid Oven Cleaning. Special this month!");
  await page.waitForTimeout(50);
  await shot("3-compose");
  await page.click("#bulkSmsSaveTemplateButton");
  await settle();
  assert.match(await status(), /quick-SMS templates are unchanged/);
  assert.equal(await page.evaluate(() => JSON.stringify(tpls)), before);
  assert.equal(globalThis.__fakeDb.tables.bulk_sms_templates[0].text, "Hi {name}, Brenna here from Rapid Oven Cleaning. Special this month!");
  const writes = await page.evaluate((n) => __writes.slice(n), writesAtStart);
  assert.deepEqual(writes, [], "no writes to leads/config/etc. from bulk SMS");
});

await step("opt-out list can be added to from the composer", async () => {
  await page.click("#bulkSmsOptOutSummary");
  await page.fill("#bulkSmsOptOutNumber", "0466 666 666");
  await page.click("#bulkSmsOptOut button:has-text('Add')");
  await settle();
  assert.match(await page.locator("#bulkSmsOptOutList").innerText(), /0466 666 666/);
});

await step("review lists problems, opted-out, shared numbers; send stays blocked until resolved", async () => {
  await page.click("#bulkSmsCloseButton");
  for (const id of ["X2", "X3", "X4", "X5"]) { await search(id === "X4" ? "img" : leadRows.find((l) => l.id === id).data.name); await tick(id); }
  await search("");
  await openModal();
  await settle();
  assert.ok(await visible("#bulkSmsComposer"), "signed in with the code: straight to composer");
  await page.selectOption("#bulkSmsTemplate", "0");
  await page.click("#bulkSmsReviewButton");
  await settle();
  const review = await page.locator("#bulkSmsReview").innerText();
  assert.match(review, /7 ticked → 4 texts will be sent/);
  assert.match(review, /No Phone — No phone number on file/);
  assert.match(review, /Opted out[\s\S]*Opt Out Person/);
  assert.match(review, /Shared numbers[\s\S]*Bowman, Trudy, Sam Lee/);
  assert.ok(await page.locator("#bulkSmsSendButton").isDisabled());
  await shot("4-review");
  assert.equal(await page.evaluate(() => window.__xss), undefined, "names are escaped, not run as HTML");
  assert.match(review, /<img src=x onerror="window.__xss=1">/, "the odd name is shown as plain text");
});

await step("changing ticks during review forces a fresh review", async () => {
  await page.evaluate(() => setClientSelected("A5", true));
  assert.ok(await visible("#bulkSmsComposer"));
  assert.match(await status(), /review again/);
  await page.evaluate(() => setClientSelected("A5", false));
  await page.click("#bulkSmsReviewButton");
  await settle();
});

await step("untick-invalid then choosing a message for the shared number enables Send", async () => {
  await page.click("text=Untick these 1 and review again");
  await settle();
  const review = await page.locator("#bulkSmsReview").innerText();
  assert.doesNotMatch(review, /Can.t send until/);
  assert.ok(await page.locator("#bulkSmsSendButton").isDisabled(), "shared-number choice still needed");
  await page.locator('input[name="bulkSmsConflict0"]').first().check();
  assert.ok(await page.locator("#bulkSmsSendButton").isEnabled());
  assert.equal(await page.locator("#bulkSmsSendButton").innerText(), "Send 4 texts");
});

await step("send goes out once, shows the result on screen, unticks only who was sent", async () => {
  await page.click("#bulkSmsSendButton");
  await settle();
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].messages.length, 4);
  assert.ok(await visible("#bulkSmsResult"), "result stays on screen");
  assert.match(await page.locator("#bulkSmsResult").innerText(), /4 of 4 accepted by MobileMessage/);
  assert.deepEqual(await selected(), ["X5"], "only the opted-out client is still ticked");
  assert.equal(await page.locator("#bulkSmsCloseButton").innerText(), "Close");
  await shot("5-result");
  await page.click("#bulkSmsCloseButton");
  assert.ok(!(await page.locator("#bulkSmsOverlay").evaluate((e) => e.classList.contains("open"))), "window closes after a send");
});

await step("reloading mid-send: reopening shows the real outcome, nothing is sent twice", async () => {
  await page.evaluate(() => { setClientSelected("A7", true); setClientSelected("A8", true); setClientSelected("X5", false); });
  await openModal();
  await settle();
  await page.click("#bulkSmsReviewButton");
  await settle();
  provider.delay = 800;
  await page.click("#bulkSmsSendButton");
  await page.waitForTimeout(200);
  await page.reload();
  await settle();
  provider.delay = 5;
  await page.waitForFunction(() => typeof leads !== "undefined" && leads.length > 200);
  await page.click("#nav-clients");
  assert.equal(await count(), "2 selected", "still ticked after reload, as the page never saw the result");
  await openModal();
  await settle();
  assert.match(await page.locator("#bulkSmsResult").innerText(), /Result of your last bulk send[\s\S]*2 of 2 accepted/);
  assert.equal(await count(), "0 selected");
  assert.equal(provider.calls.length, 2);
  await page.click("#bulkSmsCloseButton");
});

await step("an unconfirmed send stays ticked, is flagged, and isn't resent", async () => {
  await page.evaluate(() => setClientSelected("A9", true));
  await openModal();
  await settle();
  await page.click("#bulkSmsReviewButton");
  await settle();
  provider.mode = "throw";
  await page.click("#bulkSmsSendButton");
  await settle();
  provider.mode = "accept";
  assert.match(await page.locator("#bulkSmsResult").innerText(), /1 not confirmed[\s\S]*check your MobileMessage dashboard/);
  assert.deepEqual(await selected(), ["A9"]);
  assert.equal(provider.calls.length, 3);
});

await step("no page errors and no writes to CRM tables from bulk SMS", async () => {
  assert.deepEqual(pageErrors, []);
  const writes = await page.evaluate((n) => __writes.slice(n), writesAtStart);
  assert.deepEqual(writes, []);
});

await browser.close();
const failed = results.filter(([s]) => s === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
