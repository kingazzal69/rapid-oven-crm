# Bulk SMS setup

The CRM is a public static GitHub Pages app, so it must never contain a MobileMessage API password or an n8n webhook secret. The `bulk-sms` Supabase Edge Function checks a signed-in Supabase user against an email allowlist, then forwards the selected messages to a protected n8n webhook. Keep the MobileMessage API credentials in n8n.

## Supabase

1. In the Supabase dashboard for project `haarvltpfcbixqbwkxpl`, create or invite the CRM user's account under **Authentication → Users**. Do not expose public account registration for this SMS action.
2. Install and sign in to the Supabase CLI, then deploy the function with JWT verification enabled:

   ```sh
   supabase functions deploy bulk-sms --project-ref haarvltpfcbixqbwkxpl
   ```

3. Set the function secrets. Use the exact email address invited above and the HTTPS production webhook URL from the n8n workflow:

   ```sh
   supabase secrets set \
     SMS_ALLOWED_EMAILS="you@example.com" \
     N8N_SMS_WEBHOOK_URL="https://your-n8n-host/webhook/your-private-path" \
     N8N_SMS_WEBHOOK_SECRET="use-a-long-random-secret" \
     CRM_ORIGIN="https://kingazzal69.github.io" \
     --project-ref haarvltpfcbixqbwkxpl
   ```

   Multiple allowed emails can be comma-separated. Keep the webhook URL and secret out of `index.html` and Git.

## n8n workflow

Create an HTTPS Webhook trigger that requires header authentication using the same value stored in `N8N_SMS_WEBHOOK_SECRET` as `X-CRM-SMS-Secret`. The Edge Function sends this JSON body:

```json
{
  "request_id": "unique-request-id",
  "template_name": "Quote follow-up",
  "requested_by": "you@example.com",
  "messages": [
    {"lead_id": "crm-lead-id", "to": "61412345678", "message": "Hi Sam, ..."}
  ]
}
```

Use the n8n MobileMessage credential to submit one batch to `POST https://api.mobilemessage.com.au/v1/messages`. Map each message's `to` and `message`, pass `lead_id` as MobileMessage's `custom_ref`, and include a registered MobileMessage sender ID. Send `request_id` as MobileMessage's `Idempotency-Key` header so retries do not send duplicates. Return a 2xx response only after MobileMessage accepts the batch; otherwise return an error so the CRM keeps the selection for retry.

The CRM only clears its checked clients after the Edge Function receives that successful response. A network failure can leave the result uncertain; reusing the same request ID lets MobileMessage return the original batch response during its idempotency window.
