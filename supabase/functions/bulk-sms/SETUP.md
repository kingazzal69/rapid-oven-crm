# Bulk SMS — setup, testing and rollback

How it fits together:

```
CRM page (tick clients → Bulk SMS)          index.html
   │  signed in + two-factor code
   ▼
Supabase Edge Function "bulk-sms"            supabase/functions/bulk-sms/index.ts
   │  re-checks who you are, looks up the real numbers, merges duplicates,
   │  removes opted-out numbers, records the batch so it can only send once
   ▼  (secret header)
n8n workflow "Rapid Oven – Bulk SMS (MobileMessage)"   n8n/rapid-oven-bulk-sms.workflow.ts
   │  sends through MobileMessage, reports each text's result,
   │  posts a summary to Telegram
   ▼
MobileMessage → customers' phones
```

Nothing here changes the existing CRM tables, the ServiceM8/Square syncs, or any existing n8n workflow.
Passwords, API keys and tokens go only into the Supabase and n8n settings screens — never into
`index.html`, Git, chat or screenshots.

---

## 1. Supabase (dashboard for project `haarvltpfcbixqbwkxpl`)

**a. Add the bulk SMS tables.** SQL Editor → New query → paste all of
`supabase/migrations/0001_bulk_sms.sql` → Run. It only adds new `bulk_sms_*` tables; it touches
nothing that exists. Running it twice is harmless.

**b. Create your bulk SMS login.** Authentication → Users → Add user → Create new user. Use your
email and a strong password, tick *Auto Confirm User*.
Then Authentication → Sign In / Providers → turn **off** "Allow new users to sign up" (the CRM
doesn't use sign-ups for anything else).

**c. Two-factor.** Authentication → Multi-Factor: make sure **TOTP (authenticator app)** is enabled
(it is by default). Bulk SMS now uses the CRM's own shared login, so the code is set up once for the
whole CRM: open the CRM with `#setup-2fa` on the end of the address, sign in, and scan the QR code with
the authenticator app (the CRM never offers a QR code otherwise). Do this straight away: until two-factor
is set up, anyone with the password could set it up with their own phone.

**d. Deploy the function.** With the Supabase CLI:

```sh
supabase functions deploy bulk-sms --project-ref haarvltpfcbixqbwkxpl
```

Leave JWT verification on (the default). No CLI? Edge Functions → Deploy a new function → name it
`bulk-sms` → paste `supabase/functions/bulk-sms/index.ts`.

**e. Function settings (secrets).** Edge Functions → Secrets (or `supabase secrets set ...`):

| Name | Value |
|---|---|
| `SMS_ALLOWED_EMAILS` | the email from step b |
| `N8N_SMS_WEBHOOK_URL` | `https://n8n-zpwc.srv1796638.hstgr.cloud/webhook/rapid-oven-bulk-sms` |
| `N8N_SMS_WEBHOOK_SECRET` | a long random string you make (e.g. `openssl rand -hex 32`); the same value goes into n8n in step 2a |
| `CRM_ORIGIN` | `https://kingazzal69.github.io` |
| `SMS_TEST_ALLOWLIST` | **for testing only**: your own mobile(s), comma-separated. While set, nothing else can be texted. Delete it to go live. |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically.

## 2. n8n — workflow "Rapid Oven – Bulk SMS (MobileMessage)" (id `aRcdRb22RQCmPK5C`)

It was created **switched off**. Leave it off until testing step 3b.

**a. Webhook secret — create a new login, don't reuse the old one.**
The workflow's web address is public, so every request from Supabase carries a secret password in
a header and n8n rejects anything without it. n8n keeps that password in a "Header Auth" login.
When the workflow was created, n8n auto-picked your existing **"Header Auth account"** — that one
probably belongs to another workflow with its own password, so don't change it.
Instead: Credentials → Add credential → **Header Auth** → Name: `X-CRM-SMS-Secret`,
Value: the string from 1e → save as **"Bulk SMS Webhook Secret"**. Open the workflow's
*Bulk SMS Webhook* step and select it.

**b. MobileMessage login.** In MobileMessage: Settings → API → create an API key; it gives an API
**username** and **password**. In n8n: Credentials → Add credential → **Basic Auth** → paste them →
save as **"MobileMessage API"**. Select it on the *Send via MobileMessage* step.

**c. Sender ID.** This is who the text appears to come from on the customer's phone. In MobileMessage,
look under your sender IDs / numbers. Options:
- a **dedicated number** you rent from MobileMessage — customers can reply (recommended, so
  "STOP" replies reach you);
- your own verified mobile;
- a business name like `RapidOven` — must be registered, or Australian carriers may block or relabel
  it, and customers can't reply.

Type it exactly as MobileMessage shows it into the *Add Sender ID* step.

**d. Telegram confirmation.** In n8n, one Telegram login holds exactly one bot's token, so a
different bot needs its own login. Credentials → Add credential → **Telegram API** → paste the new
bot's token → save as **"Telegram – Bulk SMS Bot"**. Don't edit the existing "Telegram account" —
changing its token would move your other bots onto the new bot.
Select the new login on the *Telegram Confirmation* step. **Chat ID** is the same as in your other
bots' workflows (your personal Telegram ID doesn't change between bots). Open the new bot in
Telegram and press **Start** once, or it can't message you.

**e.** Save the workflow. Still off.

## 3. Testing (in this order, before any customer is texted)

**a. Dry run, no sending.** With `SMS_TEST_ALLOWLIST` set and the workflow off: tick a handful of
real clients → Bulk SMS → Review. Check the names, numbers, merged duplicates and messages look
right. Don't press Send. (The code has also been exercised end-to-end with a fake database and a
fake MobileMessage — see *Automated checks* below.)

**b. One real text to yourself.** Set `SMS_TEST_ALLOWLIST` to your mobile. Make sure a client record
has your mobile (or add one). Switch the workflow **on**. Tick only that client → Review → Send.
Check: the text arrives with your first name; the CRM shows "1 of 1 accepted"; the Telegram summary
arrives. Then in n8n open that execution → *Send via MobileMessage* → copy its output (remove any
names/numbers) and share it, so the *Map Provider Results* step can be confirmed against
MobileMessage's real reply (it was written from MobileMessage's public docs as summarised by a
search engine, because the build environment couldn't reach mobilemessage.com.au directly).

**c. Small batch.** Add 2–5 numbers you control to `SMS_TEST_ALLOWLIST` (include two client records
sharing one number, to see them merge into one text). Send and check each phone.

**d. Go live.** Delete `SMS_TEST_ALLOWLIST`. The CRM page change goes live only when it's merged to
`main`.

## 4. Using it

Tick clients (across any pages, searches or filters) → **Bulk SMS** → choose a template → **Review**:
- *Can't send until fixed* — no/invalid mobile: fix the number in the client, or untick them.
- *Opted out* — on the opt-out list; skipped even though ticked.
- *Shared numbers* — two ticked clients share a mobile but would get different wording; pick one.
- *Exact messages* — what will be sent (first 200 shown for big batches).

**Send** → result on screen and in Telegram. Accepted clients are unticked. *Rejected* ones stay
ticked to fix and retry. *Not confirmed* ones stay ticked but are **never resent automatically** —
check the MobileMessage dashboard before texting them again.

Bulk templates are their own list (copied once from the quick-SMS templates on first use);
editing one never changes the 💬 quick-SMS templates. **Opt-outs:** add a number via *Opt-out list*
in the Bulk SMS window whenever someone replies STOP. Replies aren't synced automatically, so check
MobileMessage's inbox/opt-out list regularly. For promotional texts, include an opt-out line such
as "Reply STOP to opt out".

## 5. Rollback

1. **Stop sending instantly:** switch the n8n workflow **off**. Any send attempt then fails safely
   and nothing is marked as sent.
2. Optionally also clear `SMS_ALLOWED_EMAILS` in Supabase — the function then refuses everyone.
3. Check the latest execution in n8n finished, in case a batch was mid-send.
4. To remove the button from the CRM, revert the bulk SMS commit on `main` (other CRM changes stay).
5. Keep the `bulk_sms_*` tables — they're the history of what was sent. Don't touch the existing
   sync workflows. Texts already sent can't be recalled.

## 6. Limits and known gaps

- Up to 10,000 different numbers per send (MobileMessage's per-request limit).
- "Accepted" means MobileMessage queued it; delivery to the handset isn't tracked (agreed as enough).
- MobileMessage details (Basic Auth, `POST https://api.mobilemessage.com.au/v1/messages`,
  `messages[{to, message, sender, custom_ref}]`, `Idempotency-Key` kept 24h) come from
  <https://mobilemessage.com.au/api-documentation> via search summaries; confirm in step 3b.

## Automated checks

```sh
node supabase/functions/bulk-sms/test/run.mjs        # server function vs fake database + fake MobileMessage
node supabase/functions/bulk-sms/test/workflow.mjs   # the n8n workflow's code steps
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
  node supabase/functions/bulk-sms/test/browser.mjs  # the CRM page in headless Chromium
```

None of these contact Supabase, n8n, MobileMessage or Telegram, and none sends a text.
