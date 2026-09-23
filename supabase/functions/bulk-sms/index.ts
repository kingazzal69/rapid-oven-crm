// Bulk SMS backend for the Rapid Oven Cleaning CRM.
//
// Every action here re-checks the caller's Supabase Auth JWT against
// SMS_ALLOWED_EMAILS itself — it never trusts the browser's own notion of
// who is signed in, and never infers authorization from Git metadata.
// All table access uses the service-role client (bypassing RLS) because the
// bulk_sms_* tables grant nothing to anon/authenticated; this function is
// the only door in.
//
// Actions (body.action):
//   templates.list   -> list dedicated bulk-SMS templates, seeding them once
//                        from the browser's existing quick-SMS templates.
//   templates.save   -> update one dedicated template's text.
//   prepare          -> resolve+validate a selection into a frozen batch
//                        preview (dedupe, suppression, conflicts).
//   submit           -> send a previously prepared, unchanged batch.
//   history.list     -> recent batches + recipient status counts.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const allowedOrigin = Deno.env.get("CRM_ORIGIN") ?? "https://kingazzal69.github.io";
const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function reply(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function canonicalAuMobile(raw: unknown): string | null {
  let d = (typeof raw === "string" ? raw : "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("61")) d = d;
  else if (d.startsWith("0")) d = "61" + d.slice(1);
  else if (d.length === 9 && d.startsWith("4")) d = "61" + d;
  return /^614\d{8}$/.test(d) ? d : null;
}

function personalise(lead: Record<string, unknown>, templateText: string): string {
  const name = typeof lead.name === "string" ? lead.name : "";
  const first = name.includes(",") ? name.split(",")[1]?.trim().split(" ")[0] ?? name : name.split(" ")[0] ?? name;
  const jobDate = typeof lead.jobDate === "string" ? lead.jobDate : "";
  const jobTime = typeof lead.jobTime === "string" ? lead.jobTime : "";
  const map: Record<string, string> = {
    "{name}": first || "",
    "{service}": typeof lead.service === "string" ? lead.service : "",
    "{value}": lead.value != null ? String(lead.value) : "",
    "{suburb}": typeof lead.suburb === "string" ? lead.suburb : "",
    "{address}": typeof lead.address === "string" ? lead.address : "",
    "{jobwhen}": jobDate ? ` for ${jobDate}${jobTime ? " at " + jobTime : ""}` : "",
  };
  return templateText.replace(/\{name\}|\{service\}|\{value\}|\{suburb\}|\{address\}|\{jobwhen\}/g, (m) => map[m] ?? m);
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface RecipientDraft {
  canonical_number: string;
  message: string;
  lead_ids: string[];
  names: string[];
}

async function resolveRecipients(
  db: SupabaseClient,
  leadIds: string[],
  templateText: string,
): Promise<{
  recipients: RecipientDraft[];
  invalid: { lead_id: string; name: string; reason: string }[];
  suppressed: { lead_id: string; name: string; canonical_number: string }[];
  conflicts: { canonical_number: string; lead_ids: string[]; messages: string[] }[];
}> {
  const invalid: { lead_id: string; name: string; reason: string }[] = [];
  const suppressed: { lead_id: string; name: string; canonical_number: string }[] = [];
  const byNumber = new Map<string, RecipientDraft>();
  const conflictsByNumber = new Map<string, Set<string>>();

  // leads is {id text, data jsonb}; page through in chunks of 500 ids to
  // avoid an oversized IN() clause on a large bulk selection.
  const leadById = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < leadIds.length; i += 500) {
    const chunk = leadIds.slice(i, i + 500);
    const { data, error } = await db.from("leads").select("id,data").in("id", chunk);
    if (error) throw new Error("Could not load authoritative client records: " + error.message);
    for (const row of data ?? []) {
      leadById.set(String(row.id), (row.data as Record<string, unknown>) ?? {});
    }
  }

  const { data: suppressionRows, error: suppressionError } = await db
    .from("bulk_sms_suppressions")
    .select("canonical_number");
  if (suppressionError) throw new Error("Could not load the suppression list: " + suppressionError.message);
  const suppressedNumbers = new Set((suppressionRows ?? []).map((r) => String(r.canonical_number)));

  for (const leadId of leadIds) {
    const lead = leadById.get(leadId);
    const name = lead && typeof lead.name === "string" ? lead.name : leadId;
    if (!lead) {
      invalid.push({ lead_id: leadId, name, reason: "Client record not found or not loaded." });
      continue;
    }
    const canonical = canonicalAuMobile(lead.phone);
    if (!canonical) {
      invalid.push({ lead_id: leadId, name, reason: "No valid Australian mobile number on file." });
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
      if (existing.message !== message) {
        const set = conflictsByNumber.get(canonical) ?? new Set([existing.message]);
        set.add(message);
        conflictsByNumber.set(canonical, set);
      }
    } else {
      byNumber.set(canonical, { canonical_number: canonical, message, lead_ids: [leadId], names: [name] });
    }
  }

  const conflicts = [...conflictsByNumber.entries()].map(([canonical_number, messages]) => ({
    canonical_number,
    lead_ids: byNumber.get(canonical_number)?.lead_ids ?? [],
    messages: [...messages],
  }));

  return { recipients: [...byNumber.values()], invalid, suppressed, conflicts };
}

async function payloadHashFor(templateText: string, recipients: RecipientDraft[]): Promise<string> {
  const sorted = [...recipients]
    .map((r) => ({ canonical_number: r.canonical_number, message: r.message, lead_ids: [...r.lead_ids].sort() }))
    .sort((a, b) => a.canonical_number.localeCompare(b.canonical_number));
  return sha256Hex(JSON.stringify({ templateText, sorted }));
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
  const allowedEmails = (Deno.env.get("SMS_ALLOWED_EMAILS") ?? "")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey || !webhookUrl || !webhookSecret || !allowedEmails.length) {
    return reply({ error: "The secure SMS service is not configured." }, 503);
  }
  if (!webhookUrl.startsWith("https://")) return reply({ error: "The n8n webhook must use HTTPS." }, 503);

  const authHeader = request.headers.get("Authorization") ?? "";
  const token = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return reply({ error: "Sign in before using bulk SMS." }, 401);

  const authClient = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: { user }, error: authError } = await authClient.auth.getUser(token);
  if (authError || !user?.email) return reply({ error: "Your sign-in has expired. Sign in again." }, 401);
  if (!allowedEmails.includes(user.email.toLowerCase())) {
    return reply({ error: "This account is not authorised for bulk SMS." }, 403);
  }

  const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return reply({ error: "The request body must be valid JSON." }, 400);
  }
  const action = typeof payload.action === "string" ? payload.action : "";

  try {
    if (action === "templates.list") {
      const { data: marker } = await db.from("bulk_sms_migration_markers").select("key").eq("key", "initial_seed").maybeSingle();
      if (!marker && Array.isArray(payload.seed_from)) {
        const seed = (payload.seed_from as unknown[])
          .filter((t): t is { name: string; text: string } => !!t && typeof (t as any).name === "string" && typeof (t as any).text === "string");
        if (seed.length) {
          const { error: insertError } = await db.from("bulk_sms_templates").insert(seed);
          if (insertError) throw new Error(insertError.message);
        }
        await db.from("bulk_sms_migration_markers").insert({ key: "initial_seed" }).select();
      }
      const { data, error } = await db.from("bulk_sms_templates").select("id,name,text").order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      return reply({ templates: data ?? [] });
    }

    if (action === "templates.save") {
      const id = typeof payload.id === "string" ? payload.id : "";
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!id || !text) return reply({ error: "A template id and non-empty text are required." }, 400);
      const { error } = await db.from("bulk_sms_templates").update({ text, updated_at: new Date().toISOString() }).eq("id", id);
      if (error) throw new Error(error.message);
      return reply({ status: "saved" });
    }

    if (action === "prepare") {
      const clientBatchKey = typeof payload.client_batch_key === "string" ? payload.client_batch_key : "";
      const templateId = typeof payload.template_id === "string" ? payload.template_id : null;
      const templateName = typeof payload.template_name === "string" ? payload.template_name.slice(0, 120) : "";
      const templateText = typeof payload.template_text === "string" ? payload.template_text : "";
      const leadIds = Array.isArray(payload.lead_ids) ? payload.lead_ids.filter((x): x is string => typeof x === "string") : [];
      if (!/^[A-Za-z0-9._:-]{1,120}$/.test(clientBatchKey)) return reply({ error: "A valid batch key is required." }, 400);
      if (!templateText.trim()) return reply({ error: "Choose a template or enter a message." }, 400);
      if (!leadIds.length || leadIds.length > 10000) return reply({ error: "Select between 1 and 10,000 clients." }, 400);

      const { recipients, invalid, suppressed, conflicts } = await resolveRecipients(db, leadIds, templateText);
      const payloadHash = await payloadHashFor(templateText, recipients);

      await db.from("bulk_sms_batches").upsert({
        client_batch_key: clientBatchKey,
        payload_hash: payloadHash,
        template_id: templateId,
        template_name_snapshot: templateName,
        requested_by: user.email,
        status: "prepared",
        recipient_count: recipients.length,
      }, { onConflict: "client_batch_key" });

      return reply({
        payload_hash: payloadHash,
        selected_count: leadIds.length,
        recipient_count: recipients.length,
        recipients: recipients.map((r) => ({ canonical_number: r.canonical_number, message: r.message, lead_ids: r.lead_ids, names: r.names })),
        invalid,
        suppressed,
        conflicts,
      });
    }

    if (action === "submit") {
      const clientBatchKey = typeof payload.client_batch_key === "string" ? payload.client_batch_key : "";
      const expectedHash = typeof payload.payload_hash === "string" ? payload.payload_hash : "";
      const resolvedConflicts = payload.resolved_conflicts as Record<string, string> | undefined; // canonical_number -> chosen message
      const templateId = typeof payload.template_id === "string" ? payload.template_id : null;
      const templateName = typeof payload.template_name === "string" ? payload.template_name.slice(0, 120) : "";
      const templateText = typeof payload.template_text === "string" ? payload.template_text : "";
      const leadIds = Array.isArray(payload.lead_ids) ? payload.lead_ids.filter((x): x is string => typeof x === "string") : [];
      if (!/^[A-Za-z0-9._:-]{1,120}$/.test(clientBatchKey)) return reply({ error: "A valid batch key is required." }, 400);

      const { data: existingBatch } = await db.from("bulk_sms_batches").select("*").eq("client_batch_key", clientBatchKey).maybeSingle();
      if (existingBatch && existingBatch.status !== "prepared") {
        // Already submitted (accepted/submitting/confirmed_failed/unknown) — never resend automatically.
        return reply({ status: existingBatch.status, batch_id: existingBatch.id, message: "This batch was already submitted; it will not be sent again automatically." });
      }

      const { recipients, invalid, suppressed, conflicts } = await resolveRecipients(db, leadIds, templateText);
      if (invalid.length) return reply({ error: "Some selected clients have no valid mobile number. Fix or exclude them, then re-prepare.", invalid }, 409);
      if (conflicts.length && !resolvedConflicts) return reply({ error: "Duplicate numbers with different messages need a choice before sending.", conflicts }, 409);
      for (const c of conflicts) {
        const chosen = resolvedConflicts?.[c.canonical_number];
        if (!chosen || !c.messages.includes(chosen)) {
          return reply({ error: "A conflicting number is missing a valid chosen message.", conflicts }, 409);
        }
        const r = recipients.find((x) => x.canonical_number === c.canonical_number);
        if (r) r.message = chosen;
      }

      const payloadHash = await payloadHashFor(templateText, recipients);
      if (expectedHash && expectedHash !== payloadHash) {
        return reply({ error: "The recipients or messages changed since you reviewed this batch. Re-prepare before sending.", payload_hash: payloadHash }, 409);
      }

      const { data: batch, error: batchError } = await db.from("bulk_sms_batches").upsert({
        client_batch_key: clientBatchKey,
        payload_hash: payloadHash,
        template_id: templateId,
        template_name_snapshot: templateName,
        requested_by: user.email,
        status: "submitting",
        recipient_count: recipients.length,
        submitted_at: new Date().toISOString(),
      }, { onConflict: "client_batch_key" }).select().single();
      if (batchError || !batch) throw new Error(batchError?.message ?? "Could not create the batch.");

      const recipientRows = recipients.map((r) => ({
        batch_id: batch.id,
        operation_id: `${batch.id}:${r.canonical_number}`,
        canonical_number: r.canonical_number,
        message: r.message,
        lead_ids: r.lead_ids,
        status: "submitting",
      }));
      const { error: recipientsError } = await db.from("bulk_sms_recipients").upsert(recipientRows, { onConflict: "operation_id" });
      if (recipientsError) throw new Error(recipientsError.message);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      let upstreamBody: unknown;
      try {
        const upstream = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CRM-SMS-Secret": webhookSecret },
          body: JSON.stringify({
            batch_id: batch.id,
            template_name: templateName,
            requested_by: user.email,
            messages: recipientRows.map((r) => ({ operation_id: r.operation_id, to: r.canonical_number, message: r.message })),
          }),
          signal: controller.signal,
        });
        upstreamBody = await upstream.json().catch(() => null);
        if (!upstream.ok || !upstreamBody || !Array.isArray((upstreamBody as any).results)) {
          await db.from("bulk_sms_batches").update({ status: "unknown", resolved_at: new Date().toISOString() }).eq("id", batch.id);
          await db.from("bulk_sms_recipients").update({ status: "unknown" }).eq("batch_id", batch.id);
          console.error("n8n SMS workflow returned an unexpected response", upstream.status);
          return reply({ error: "The SMS workflow response could not be validated. Recipients are marked unknown and will not auto-retry.", status: "unknown", batch_id: batch.id }, 502);
        }
      } catch (error) {
        await db.from("bulk_sms_batches").update({ status: "unknown", resolved_at: new Date().toISOString() }).eq("id", batch.id);
        await db.from("bulk_sms_recipients").update({ status: "unknown" }).eq("batch_id", batch.id);
        console.error("n8n SMS workflow request failed", error instanceof Error ? error.name : "unknown error");
        return reply({ error: "Could not confirm the SMS workflow received this batch. Recipients are marked unknown and will not auto-retry.", status: "unknown", batch_id: batch.id }, 502);
      } finally {
        clearTimeout(timeout);
      }

      const results = (upstreamBody as any).results as Array<{ operation_id?: string; status?: string; provider_message_id?: string; error?: string }>;
      let acceptedCount = 0, failedCount = 0, unknownCount = 0;
      for (const r of results) {
        const opId = typeof r.operation_id === "string" ? r.operation_id : "";
        if (!opId) continue;
        const status = r.status === "accepted" ? "accepted" : r.status === "confirmed_failed" ? "confirmed_failed" : "unknown";
        if (status === "accepted") acceptedCount++; else if (status === "confirmed_failed") failedCount++; else unknownCount++;
        await db.from("bulk_sms_recipients").update({
          status,
          provider_message_id: typeof r.provider_message_id === "string" ? r.provider_message_id : null,
          provider_response: r as unknown as Record<string, unknown>,
          updated_at: new Date().toISOString(),
        }).eq("operation_id", opId);
      }
      const batchStatus = unknownCount ? "unknown" : failedCount && !acceptedCount ? "confirmed_failed" : "accepted";
      await db.from("bulk_sms_batches").update({ status: batchStatus, resolved_at: new Date().toISOString() }).eq("id", batch.id);

      return reply({
        status: batchStatus,
        batch_id: batch.id,
        accepted_count: acceptedCount,
        confirmed_failed_count: failedCount,
        unknown_count: unknownCount,
        results,
      });
    }

    if (action === "history.list") {
      const { data: batches, error } = await db
        .from("bulk_sms_batches")
        .select("id,template_name_snapshot,requested_by,status,recipient_count,created_at,submitted_at,resolved_at")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw new Error(error.message);
      return reply({ batches: batches ?? [] });
    }

    return reply({ error: "Unknown action." }, 400);
  } catch (error) {
    console.error("bulk-sms action failed", action, error instanceof Error ? error.message : error);
    return reply({ error: error instanceof Error ? error.message : "Unexpected server error." }, 500);
  }
});
