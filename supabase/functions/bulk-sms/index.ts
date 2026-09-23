import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin");
  if (origin && origin !== allowedOrigin) return reply({ error: "Origin not allowed." }, 403);
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const webhookUrl = Deno.env.get("N8N_SMS_WEBHOOK_URL");
  const webhookSecret = Deno.env.get("N8N_SMS_WEBHOOK_SECRET");
  const allowedEmails = (Deno.env.get("SMS_ALLOWED_EMAILS") ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  if (!supabaseUrl || !supabaseAnonKey || !webhookUrl || !webhookSecret || !allowedEmails.length) {
    return reply({ error: "The secure SMS service is not configured." }, 503);
  }
  if (!webhookUrl.startsWith("https://")) {
    return reply({ error: "The n8n webhook must use HTTPS." }, 503);
  }

  const authHeader = request.headers.get("Authorization") ?? "";
  const token = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return reply({ error: "Sign in before sending SMS." }, 401);

  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: authError } = await authClient.auth.getUser(token);
  if (authError || !user?.email) return reply({ error: "Your sign-in has expired. Sign in again." }, 401);
  if (!allowedEmails.includes(user.email.toLowerCase())) {
    return reply({ error: "This account is not authorised to send SMS." }, 403);
  }

  let payload: {
    request_id?: unknown;
    template_name?: unknown;
    messages?: unknown;
  };
  try {
    payload = await request.json();
  } catch {
    return reply({ error: "The request body must be valid JSON." }, 400);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return reply({ error: "The request body must be a JSON object." }, 400);
  }

  const requestId = typeof payload.request_id === "string" ? payload.request_id : "";
  const templateName = typeof payload.template_name === "string" ? payload.template_name.slice(0, 120) : "";
  const messages = payload.messages;
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(requestId)) {
    return reply({ error: "A valid request ID is required." }, 400);
  }
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 10000) {
    return reply({ error: "Select between 1 and 10,000 clients for a batch." }, 400);
  }

  const validMessages: Array<{ lead_id: string; to: string; message: string }> = [];
  for (const item of messages) {
    if (!item || typeof item !== "object") return reply({ error: "A message in the batch is invalid." }, 400);
    const row = item as { lead_id?: unknown; to?: unknown; message?: unknown };
    const leadId = typeof row.lead_id === "string" ? row.lead_id.slice(0, 160) : "";
    const to = typeof row.to === "string" ? row.to.replace(/\D/g, "") : "";
    const message = typeof row.message === "string" ? row.message.trim() : "";
    if (!leadId || !/^(?:04\d{8}|614\d{8})$/.test(to) || !message) {
      return reply({ error: "Every selected client needs a valid Australian mobile number and a non-empty message." }, 400);
    }
    validMessages.push({ lead_id: leadId, to, message });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const upstream = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CRM-SMS-Secret": webhookSecret,
      },
      body: JSON.stringify({
        request_id: requestId,
        template_name: templateName,
        requested_by: user.email,
        messages: validMessages,
      }),
      signal: controller.signal,
    });
    if (!upstream.ok) {
      console.error("n8n SMS workflow returned HTTP", upstream.status);
      return reply({ error: "The SMS workflow rejected the batch. Your selections are unchanged." }, 502);
    }
    return reply({ status: "accepted", count: validMessages.length }, 200);
  } catch (error) {
    console.error("n8n SMS workflow request failed", error instanceof Error ? error.name : "unknown error");
    return reply({ error: "Could not reach the SMS workflow. Your selections are unchanged." }, 502);
  } finally {
    clearTimeout(timeout);
  }
});
