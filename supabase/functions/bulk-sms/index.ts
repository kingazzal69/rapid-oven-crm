// Bulk SMS backend for the Rapid Oven Cleaning CRM.
//
// Every action re-checks the caller's Supabase Auth JWT: the email must be in
// SMS_ALLOWED_EMAILS and the session must have passed two-factor (aal2).
// All table access uses the service-role client because the bulk_sms_* tables
// grant nothing to anon/authenticated — this function is the only way in.
//
// Actions (body.action):
//   templates.list / templates.save      dedicated bulk templates (separate from quick-SMS)
//   suppressions.list / .add / .remove   opt-out list
//   prepare                              resolve a selection into a reviewable batch
//   submit                               send a prepared, unchanged batch exactly once
//   batch.status                         outcome of a batch (for reload/reopen recovery)

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const allowedOrigin = Deno.env.get("CRM_ORIGIN") ?? "https://kingazzal69.github.io";
const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const MAX_RECIPIENTS = 10000;
const BATCH_KEY_RE = /^[A-Za-z0-9._:-]{1,120}$/;

function reply(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function canonicalAuMobile(raw: unknown): string | null {
  let d = (typeof raw === "string" ? raw : "").replace(/\D/g, "");
  if (d.startsWith("0")) d = "61" + d.slice(1);
  else if (d.length === 9 && d.startsWith("4")) d = "61" + d;
  return /^614\d{8}$/.test(d) ? d : null;
}

// Must stay identical to firstNameOf/fmtD/fmtTime12/personaliseSmsText in index.html
// so the browser's live preview matches what is actually sent.
function firstNameOf(name: unknown): string {
  const n = (typeof name === "string" ? name : "").trim();
  if (!n) return "there";
  if (n.includes(",")) {
    const after = (n.split(",")[1] ?? "").trim().split(/\s+/)[0];
    if (after) return after;
  }
  return n.split(/\s+/)[0] || "there";
}
function fmtD(s: string): string {
  const p = s.split("-");
  return (+p[2]) + " " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+p[1] - 1];
}
function fmtTime12(t: string): string {
  const [h, mm] = t.split(":");
  let hh = +h;
  const ap = hh >= 12 ? "pm" : "am";
  hh = hh % 12 || 12;
  return hh + (mm !== "00" ? ":" + mm : "") + ap;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function personalise(lead: Record<string, unknown>, templateText: string): string {
  const jobDate = str(lead.jobDate);
  const jobTime = str(lead.jobTime);
  const value = lead.value ? " ($" + (+(lead.value as number)).toLocaleString("en-AU") + ")" : "";
  const map: Record<string, string> = {
    "{name}": firstNameOf(lead.name),
    "{service}": str(lead.service).toLowerCase(),
    "{value}": value,
    "{suburb}": str(lead.suburb),
    "{address}": str(lead.address),
    "{jobwhen}": jobDate ? " for " + fmtD(jobDate) + (jobTime ? " at " + fmtTime12(jobTime) : "") : "",
  };
  return templateText.replace(/\{name\}|\{service\}|\{value\}|\{suburb\}|\{address\}|\{jobwhen\}/g, (m) => map[m] ?? m);
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function jwtClaims(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), "=")));
  } catch {
    return {};
  }
}

// Supabase caps a select at 1000 rows, so page through anything unbounded.
async function selectAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

interface Recipient {
  canonical_number: string;
  message: string;
  lead_ids: string[];
  names: string[];
}
interface Resolution {
  recipients: Recipient[];
  invalid: { lead_id: string; name: string; reason: string }[];
  suppressed: { lead_id: string; name: string; canonical_number: string }[];
  conflicts: { canonical_number: string; lead_ids: string[]; names: string[]; messages: string[] }[];
}

// While set (comma-separated mobiles), only these numbers can be texted — for the
// supervised first live tests. Unset it to allow normal sends.
function testAllowlist(): Set<string> | null {
  const raw = Deno.env.get("SMS_TEST_ALLOWLIST");
  if (!raw || !raw.trim()) return null;
  return new Set(raw.split(",").map((n) => canonicalAuMobile(n.trim())).filter((n): n is string => !!n));
}

async function resolveRecipients(db: SupabaseClient, leadIds: string[], templateText: string): Promise<Resolution> {
  const allowlist = testAllowlist();
  const leadById = new Map<string, Record<string, unknown>>();
  // Small chunks keep the PostgREST GET URL well under length limits.
  for (let i = 0; i < leadIds.length; i += 100) {
    const { data, error } = await db.from("leads").select("id,data").in("id", leadIds.slice(i, i + 100));
    if (error) throw new Error("Could not load client records: " + error.message);
    for (const row of data ?? []) leadById.set(String(row.id), (row.data as Record<string, unknown>) ?? {});
  }
  const suppressedNumbers = new Set(
    (await selectAll<{ canonical_number: string }>((a, b) =>
      db.from("bulk_sms_suppressions").select("canonical_number").order("canonical_number").range(a, b)
    )).map((r) => r.canonical_number),
  );

  const invalid: Resolution["invalid"] = [];
  const suppressed: Resolution["suppressed"] = [];
  const byNumber = new Map<string, Recipient>();
  const messagesByNumber = new Map<string, Set<string>>();

  for (const leadId of leadIds) {
    const lead = leadById.get(leadId);
    if (!lead) {
      invalid.push({ lead_id: leadId, name: leadId, reason: "Client record not found (it may have been deleted)." });
      continue;
    }
    const name = str(lead.name) || leadId;
    const canonical = canonicalAuMobile(lead.phone);
    if (!canonical) {
      invalid.push({ lead_id: leadId, name, reason: str(lead.phone) ? `"${str(lead.phone)}" is not an Australian mobile number.` : "No phone number on file." });
      continue;
    }
    if (allowlist && !allowlist.has(canonical)) {
      invalid.push({ lead_id: leadId, name, reason: "Test mode: this number isn't on SMS_TEST_ALLOWLIST, so it can't be texted yet." });
      continue;
    }
    if (suppressedNumbers.has(canonical)) {
      suppressed.push({ lead_id: leadId, name, canonical_number: canonical });
      continue;
    }
    const message = personalise(lead, templateText);
    const existing = byNumber.get(canonical);
    if (existing) {
      existing.lead_ids.push(leadId);
      existing.names.push(name);
    } else {
      byNumber.set(canonical, { canonical_number: canonical, message, lead_ids: [leadId], names: [name] });
    }
    const set = messagesByNumber.get(canonical) ?? new Set<string>();
    set.add(message);
    messagesByNumber.set(canonical, set);
  }

  const conflicts = [...messagesByNumber.entries()]
    .filter(([, msgs]) => msgs.size > 1)
    .map(([n, msgs]) => ({ canonical_number: n, lead_ids: byNumber.get(n)!.lead_ids, names: byNumber.get(n)!.names, messages: [...msgs] }));
  return { recipients: [...byNumber.values()], invalid, suppressed, conflicts };
}

function payloadHash(templateText: string, r: Resolution): Promise<string> {
  const recipients = [...r.recipients]
    .map((x) => ({ n: x.canonical_number, m: x.message, l: [...x.lead_ids].sort() }))
    .sort((a, b) => a.n.localeCompare(b.n));
  const conflicts = r.conflicts.map((c) => ({ n: c.canonical_number, m: [...c.messages].sort() })).sort((a, b) => a.n.localeCompare(b.n));
  const excluded = [...r.invalid.map((x) => x.lead_id), ...r.suppressed.map((x) => x.lead_id)].sort();
  return sha256Hex(JSON.stringify({ templateText, recipients, conflicts, excluded }));
}

async function batchOutcome(db: SupabaseClient, batch: Record<string, unknown>) {
  const rows = await selectAll<Record<string, unknown>>((a, b) =>
    db.from("bulk_sms_recipients").select("canonical_number,lead_ids,status,provider_message_id").eq("batch_id", batch.id).order("canonical_number").range(a, b)
  );
  const pick = (s: string) => rows.filter((r) => r.status === s);
  return {
    batch_id: batch.id,
    status: batch.status,
    template_name: batch.template_name_snapshot,
    recipient_count: batch.recipient_count,
    accepted_count: pick("accepted").length,
    confirmed_failed: pick("confirmed_failed").map((r) => ({ canonical_number: r.canonical_number, lead_ids: r.lead_ids })),
    unknown: [...pick("unknown"), ...pick("submitting")].map((r) => ({ canonical_number: r.canonical_number, lead_ids: r.lead_ids })),
    accepted_lead_ids: pick("accepted").flatMap((r) => r.lead_ids as string[]),
  };
}

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin");
  if (origin && origin !== allowedOrigin) return reply({ error: "Origin not allowed." }, 403);
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const webhookUrl = Deno.env.get("N8N_SMS_WEBHOOK_URL");
  const webhookSecret = Deno.env.get("N8N_SMS_WEBHOOK_SECRET");
  const allowedEmails = (Deno.env.get("SMS_ALLOWED_EMAILS") ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey || !webhookUrl || !webhookSecret || !allowedEmails.length) {
    return reply({ error: "The secure SMS service is not configured." }, 503);
  }
  if (!webhookUrl.startsWith("https://")) return reply({ error: "The n8n webhook must use HTTPS." }, 503);

  const token = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return reply({ error: "Sign in before using bulk SMS." }, 401);
  const authClient = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: { user }, error: authError } = await authClient.auth.getUser(token);
  if (authError || !user?.email) return reply({ error: "Your sign-in has expired. Sign in again." }, 401);
  if (!allowedEmails.includes(user.email.toLowerCase())) return reply({ error: "This account is not authorised for bulk SMS." }, 403);
  // getUser() has verified the token with Supabase Auth, so its claims can be trusted.
  if (jwtClaims(token).aal !== "aal2") return reply({ error: "Enter your two-factor code before using bulk SMS.", code: "mfa_required" }, 401);

  const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return reply({ error: "The request body must be valid JSON." }, 400);
  }
  const action = str(payload.action);

  try {
    if (action === "templates.list") {
      // Claim the one-time seed marker first; only the caller that inserts it seeds.
      const { error: markerError } = await db.from("bulk_sms_migration_markers").insert({ key: "initial_seed" });
      if (!markerError && Array.isArray(payload.seed_from)) {
        const seed = (payload.seed_from as Array<Record<string, unknown>>)
          .filter((t) => t && typeof t.name === "string" && typeof t.text === "string")
          .map((t) => ({ name: String(t.name).slice(0, 120), text: String(t.text) }));
        if (seed.length) {
          const { error } = await db.from("bulk_sms_templates").insert(seed);
          if (error) {
            await db.from("bulk_sms_migration_markers").delete().eq("key", "initial_seed");
            throw new Error(error.message);
          }
        }
      }
      const { data, error } = await db.from("bulk_sms_templates").select("id,name,text").order("created_at").order("name");
      if (error) throw new Error(error.message);
      return reply({ templates: data ?? [] });
    }

    if (action === "templates.save") {
      const id = str(payload.id);
      const text = str(payload.text).trim();
      if (!id || !text) return reply({ error: "A template and non-empty text are required." }, 400);
      const { data, error } = await db.from("bulk_sms_templates").update({ text, updated_at: new Date().toISOString() }).eq("id", id).select("id");
      if (error) throw new Error(error.message);
      if (!data?.length) return reply({ error: "That template no longer exists." }, 404);
      return reply({ status: "saved" });
    }

    if (action === "suppressions.list") {
      const rows = await selectAll<Record<string, unknown>>((a, b) =>
        db.from("bulk_sms_suppressions").select("canonical_number,reason,created_at").order("created_at", { ascending: false }).range(a, b)
      );
      return reply({ suppressions: rows });
    }
    if (action === "suppressions.add") {
      const canonical = canonicalAuMobile(payload.number);
      if (!canonical) return reply({ error: "Enter a valid Australian mobile number." }, 400);
      const { error } = await db.from("bulk_sms_suppressions").upsert(
        { canonical_number: canonical, reason: str(payload.reason).slice(0, 200) || "manual", created_by: user.email },
        { onConflict: "canonical_number", ignoreDuplicates: true },
      );
      if (error) throw new Error(error.message);
      return reply({ status: "added", canonical_number: canonical });
    }
    if (action === "suppressions.remove") {
      const canonical = canonicalAuMobile(payload.number);
      if (!canonical) return reply({ error: "Enter a valid Australian mobile number." }, 400);
      const { error } = await db.from("bulk_sms_suppressions").delete().eq("canonical_number", canonical);
      if (error) throw new Error(error.message);
      return reply({ status: "removed", canonical_number: canonical });
    }

    if (action === "batch.status") {
      const key = str(payload.client_batch_key);
      if (!BATCH_KEY_RE.test(key)) return reply({ error: "A valid batch key is required." }, 400);
      const { data: batch, error } = await db.from("bulk_sms_batches").select("*").eq("client_batch_key", key).maybeSingle();
      if (error) throw new Error(error.message);
      if (!batch) return reply({ status: "none" });
      if (batch.status === "prepared") return reply({ status: "prepared" });
      return reply(await batchOutcome(db, batch));
    }

    // prepare and submit share the same inputs and resolution.
    const key = str(payload.client_batch_key);
    const templateText = str(payload.template_text);
    const templateId = str(payload.template_id) || null;
    const templateName = str(payload.template_name).slice(0, 120) || "Custom message";
    const leadIds = [...new Set(Array.isArray(payload.lead_ids) ? payload.lead_ids.filter((x): x is string => typeof x === "string") : [])];

    if (action === "prepare" || action === "submit") {
      if (!BATCH_KEY_RE.test(key)) return reply({ error: "A valid batch key is required." }, 400);
      if (!templateText.trim()) return reply({ error: "Choose a template or enter a message." }, 400);
      if (!leadIds.length) return reply({ error: "Select at least one client." }, 400);
    }

    if (action === "prepare") {
      const { data: existing } = await db.from("bulk_sms_batches").select("status").eq("client_batch_key", key).maybeSingle();
      if (existing && existing.status !== "prepared") {
        return reply({ error: "This batch was already sent.", code: "batch_used" }, 409);
      }
      const resolution = await resolveRecipients(db, leadIds, templateText);
      if (resolution.recipients.length > MAX_RECIPIENTS) {
        return reply({ error: `MobileMessage accepts up to ${MAX_RECIPIENTS.toLocaleString()} numbers per send. Untick some clients.` }, 400);
      }
      const hash = await payloadHash(templateText, resolution);
      const { error } = await db.from("bulk_sms_batches").upsert({
        client_batch_key: key,
        payload_hash: hash,
        template_id: templateId,
        template_name_snapshot: templateName,
        requested_by: user.email,
        status: "prepared",
        recipient_count: resolution.recipients.length,
      }, { onConflict: "client_batch_key" });
      if (error) throw new Error(error.message);
      return reply({
        payload_hash: hash,
        selected_count: leadIds.length,
        recipient_count: resolution.recipients.length,
        recipients: resolution.recipients,
        invalid: resolution.invalid,
        suppressed: resolution.suppressed,
        conflicts: resolution.conflicts,
      });
    }

    if (action === "submit") {
      const expectedHash = str(payload.payload_hash);
      const choices = (payload.conflict_choices ?? {}) as Record<string, unknown>;
      if (!expectedHash) return reply({ error: "Review the batch before sending." }, 400);

      const resolution = await resolveRecipients(db, leadIds, templateText);
      const hash = await payloadHash(templateText, resolution);
      if (hash !== expectedHash) {
        return reply({ error: "Something changed since you reviewed this batch (a client, number, opt-out or the message). Review it again before sending.", code: "stale_review" }, 409);
      }
      if (resolution.invalid.length) {
        return reply({ error: "Some ticked clients have no valid mobile number. Fix or untick them first.", code: "invalid_recipients" }, 409);
      }
      for (const c of resolution.conflicts) {
        const chosen = str(choices[c.canonical_number]);
        if (!c.messages.includes(chosen)) {
          return reply({ error: "Choose which message to send to each shared number.", code: "conflict_unresolved" }, 409);
        }
        resolution.recipients.find((r) => r.canonical_number === c.canonical_number)!.message = chosen;
      }
      if (!resolution.recipients.length) return reply({ error: "No one is left to text after exclusions." }, 400);

      // Atomic claim: only one request can move this batch out of 'prepared',
      // so double-clicks, two tabs or retries cannot send it twice.
      const { data: claimed, error: claimError } = await db.from("bulk_sms_batches")
        .update({ status: "submitting", submitted_at: new Date().toISOString(), payload_hash: hash, template_name_snapshot: templateName, recipient_count: resolution.recipients.length })
        .eq("client_batch_key", key).eq("status", "prepared").eq("payload_hash", hash)
        .select().maybeSingle();
      if (claimError) throw new Error(claimError.message);
      if (!claimed) {
        const { data: batch } = await db.from("bulk_sms_batches").select("*").eq("client_batch_key", key).maybeSingle();
        if (batch && batch.status !== "prepared") return reply({ ...(await batchOutcome(db, batch)), already_submitted: true });
        return reply({ error: "Review the batch before sending.", code: "stale_review" }, 409);
      }

      const recipientRows = resolution.recipients.map((r) => ({
        batch_id: claimed.id,
        operation_id: `${claimed.id}:${r.canonical_number}`,
        canonical_number: r.canonical_number,
        message: r.message,
        lead_ids: r.lead_ids,
        status: "submitting",
      }));
      for (let i = 0; i < recipientRows.length; i += 500) {
        const { error } = await db.from("bulk_sms_recipients").insert(recipientRows.slice(i, i + 500));
        if (error) {
          // Nothing has been sent yet, so it is safe to hand the batch back for another try.
          await db.from("bulk_sms_recipients").delete().eq("batch_id", claimed.id);
          await db.from("bulk_sms_batches").update({ status: "prepared", submitted_at: null }).eq("id", claimed.id);
          throw new Error("Could not record the batch before sending: " + error.message);
        }
      }

      const markAllUnknown = async () => {
        await db.from("bulk_sms_recipients").update({ status: "unknown", updated_at: new Date().toISOString() }).eq("batch_id", claimed.id).eq("status", "submitting");
        await db.from("bulk_sms_batches").update({ status: "unknown", resolved_at: new Date().toISOString() }).eq("id", claimed.id);
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);
      let results: Array<Record<string, unknown>>;
      try {
        const upstream = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CRM-SMS-Secret": webhookSecret },
          body: JSON.stringify({
            batch_id: claimed.id,
            template_name: templateName,
            requested_by: user.email,
            messages: recipientRows.map((r) => ({ operation_id: r.operation_id, to: r.canonical_number, message: r.message })),
          }),
          signal: controller.signal,
        });
        // n8n answers 404 when the workflow is switched off: it never ran, so nothing was sent.
        if (upstream.status === 404) {
          const now = new Date().toISOString();
          await db.from("bulk_sms_recipients").update({ status: "confirmed_failed", updated_at: now }).eq("batch_id", claimed.id);
          await db.from("bulk_sms_batches").update({ status: "confirmed_failed", resolved_at: now }).eq("id", claimed.id);
          return reply({ ...(await batchOutcome(db, { ...claimed, status: "confirmed_failed" })), error: "The SMS workflow is switched off in n8n, so nothing was sent. Everyone is still ticked." });
        }
        const body = await upstream.json().catch(() => null);
        if (!upstream.ok || !body || !Array.isArray(body.results)) {
          console.error("n8n SMS workflow returned an unusable response", upstream.status);
          await markAllUnknown();
          return reply({ ...(await batchOutcome(db, { ...claimed, status: "unknown" })), error: "MobileMessage's answer couldn't be confirmed. These texts may or may not have gone out, so they won't be resent automatically." }, 502);
        }
        results = body.results;
      } catch (error) {
        console.error("n8n SMS workflow request failed", error instanceof Error ? error.name : "unknown");
        await markAllUnknown();
        return reply({ ...(await batchOutcome(db, { ...claimed, status: "unknown" })), error: "Lost contact while sending. These texts may or may not have gone out, so they won't be resent automatically." }, 502);
      } finally {
        clearTimeout(timeout);
      }

      const resultByOp = new Map(results.map((r) => [str(r.operation_id), r]));
      const now = new Date().toISOString();
      // Anyone the workflow didn't report on is unknown, never assumed sent or failed.
      const finalRows = recipientRows.map((row) => {
        const r = resultByOp.get(row.operation_id);
        const status = r?.status === "accepted" ? "accepted" : r?.status === "confirmed_failed" ? "confirmed_failed" : "unknown";
        return { ...row, status, provider_message_id: r ? str(r.provider_message_id) || null : null, provider_response: r ?? null, updated_at: now };
      });
      for (let i = 0; i < finalRows.length; i += 500) {
        const { error } = await db.from("bulk_sms_recipients").upsert(finalRows.slice(i, i + 500), { onConflict: "operation_id" });
        if (error) console.error("Could not record SMS results", error.message);
      }

      const outcome = await batchOutcome(db, claimed);
      const batchStatus = outcome.unknown.length ? "unknown" : outcome.accepted_count ? "accepted" : "confirmed_failed";
      await db.from("bulk_sms_batches").update({ status: batchStatus, resolved_at: new Date().toISOString() }).eq("id", claimed.id);
      return reply({ ...outcome, status: batchStatus });
    }

    return reply({ error: "Unknown action." }, 400);
  } catch (error) {
    console.error("bulk-sms action failed", action, error instanceof Error ? error.message : error);
    return reply({ error: error instanceof Error ? error.message : "Unexpected server error." }, 500);
  }
});
