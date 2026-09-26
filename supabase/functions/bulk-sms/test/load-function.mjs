// Compiles index.ts and loads it with the Supabase import swapped for the test shim.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const TEST_ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  N8N_SMS_WEBHOOK_URL: "https://n8n.example/webhook/rapid-oven-bulk-sms",
  N8N_SMS_WEBHOOK_SECRET: "test-secret",
  SMS_ALLOWED_EMAILS: "aaron@example.com",
  CRM_ORIGIN: "https://kingazzal69.github.io",
};

export async function loadHandler(env = TEST_ENV) {
  const work = mkdtempSync(join(tmpdir(), "bulk-sms-test-"));
  const compiled = execFileSync("npx", ["--yes", "esbuild@0.24", join(here, "..", "index.ts"), "--format=esm", "--log-level=error"], { encoding: "utf8" })
    .replace("https://esm.sh/@supabase/supabase-js@2", pathToFileURL(join(here, "supabase-shim.mjs")).href);
  writeFileSync(join(work, "fn.mjs"), compiled);
  let handler;
  globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
  await import(pathToFileURL(join(work, "fn.mjs")).href);
  return handler;
}

export const jwt = (claims) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
