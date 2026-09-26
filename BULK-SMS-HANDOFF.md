# Bulk SMS — handover (where we're up to)

Last updated 2026-09-26. Branch: `claude/brave-thompson-1me8tr` (NOT `main`). The live CRM
deploys from `main` and has **not** been changed. Read `CLAUDE.md` and
`supabase/functions/bulk-sms/SETUP.md` before doing anything.

## Goal (Aaron's words, summarised)

Tick customers in the Clients Database → press **Bulk SMS** at the top → pick a template → each
ticked person gets a personalised SMS (their first name, their number) via Aaron's
**MobileMessage** account → confirmation on screen and on **Telegram**.

## Decisions already made

- Texts go **only to the ticked clients** (active or archived — whoever is ticked).
- **Two-factor** sign-in is required for Bulk SMS (whole-CRM login/2FA is a separate job for later).
- Confirmation = **on screen + Telegram**. "Accepted by MobileMessage" is enough; delivery-to-phone
  tracking not needed.
- Sender ID: **`OvenClean`** (ACMA-registered custom sender; one-way — customers can't reply to it).
  Promo templates need an opt-out line pointing somewhere that works (e.g. a dedicated number).
- Opt-outs: **manual opt-out list** in the Bulk SMS window for now; opted-out numbers are blocked
  server-side even if ticked.
- The n8n automation is a **brand-new workflow**; no existing workflow may be edited.
- Git: commit as `Aaron <accounts@rapidovencleaning.com>` (see CLAUDE.md); pushing the feature
  branch as a backup is fine; **push to `main` / "make it live" only when Aaron explicitly says so.**

## Done

- **CRM page** (`index.html`, on the branch only): Bulk SMS button next to "All stages"; ticks kept
  across pages/filters/reloads; sign-in + two-factor; separate bulk template list (never touches
  quick-SMS templates); server **review** screen (invalid numbers, opted-out, shared numbers,
  exact messages); send once; result screen; recovery after reload mid-send.
- **Server function** `supabase/functions/bulk-sms/index.ts`: owner email + 2FA check, re-reads
  numbers from `leads`, merges duplicates, opt-out list, one-time atomic send per batch,
  `SMS_TEST_ALLOWLIST` test mode, safe handling of timeouts/unclear answers (never auto-resends).
- **Database changes** (not yet applied): `supabase/migrations/0001_bulk_sms.sql` — 5 new
  `bulk_sms_*` tables only.
- **n8n workflow** "Rapid Oven – Bulk SMS (MobileMessage)", id `aRcdRb22RQCmPK5C`, **switched off**.
  Aaron has filled in: sender ID `OvenClean`; MobileMessage Basic Auth login; a new Telegram bot
  login ("Telegram account 4") + his chat ID; a new Header Auth login with header
  `X-CRM-SMS-Secret` (not the old shared "Header Auth account"). Source: `n8n/rapid-oven-bulk-sms.workflow.ts`.
  All 10 pre-existing workflows were verified unchanged after it was created.
- **Tests** (no network, no real SMS): `node supabase/functions/bulk-sms/test/run.mjs` (20/20),
  `.../workflow.mjs`, `.../browser.mjs` (11/11, needs Playwright).

## Next step: Supabase setup (needs Aaron's browser — the cloud session can't reach Supabase)

Project `haarvltpfcbixqbwkxpl`. Rules: **only add**; snapshot before and after (public tables + RLS
on/off, Edge Functions, secret *names*, Auth user count, sign-up setting, MFA setting) and show the
diff; first confirm no `bulk_sms_*` tables, no `bulk-sms` function and none of the secret names
below already exist (stop and ask if they do); Aaron types every password/secret himself — never
in chat; don't switch off sign-ups without asking (the CRM has no `signUp` call, but it's an
existing setting).

1. SQL Editor → run all of `supabase/migrations/0001_bulk_sms.sql`.
2. Authentication → Users → Add user (Aaron's email + password, Auto Confirm).
3. Authentication → Multi-Factor → confirm TOTP enabled.
4. Edge Functions → deploy `bulk-sms` from `supabase/functions/bulk-sms/index.ts` (Verify JWT on).
5. Edge Function secrets: `SMS_ALLOWED_EMAILS` = Aaron's email;
   `N8N_SMS_WEBHOOK_URL` = `https://n8n-zpwc.srv1796638.hstgr.cloud/webhook/rapid-oven-bulk-sms`;
   `N8N_SMS_WEBHOOK_SECRET` = same value as the n8n Header Auth login;
   `CRM_ORIGIN` = see testing below; `SMS_TEST_ALLOWLIST` = Aaron's mobile.
6. Check (no side effects): POST `https://haarvltpfcbixqbwkxpl.supabase.co/functions/v1/bulk-sms`
   with `Origin` = the CRM_ORIGIN value, `Authorization: Bearer <anon key from index.html>`,
   body `{"action":"templates.list"}` → expect **401 "Your sign-in has expired"**
   (503 = a secret is missing, 403 "Origin not allowed" = Origin/CRM_ORIGIN mismatch).

## Then: testing before anything goes live

The new page isn't on the live site yet, so test it from Aaron's computer:

- Get the branch (use a **fresh clone** so the old uncommitted `codex/bulk-sms` work in the old
  folder isn't disturbed): `git clone -b claude/brave-thompson-1me8tr https://github.com/kingazzal69/rapid-oven-crm.git rapid-oven-crm-bulk-sms`
- Serve it: in that folder run `python3 -m http.server 8000`, open `http://localhost:8000`.
- While testing, set the secret `CRM_ORIGIN` = `http://localhost:8000` (the function only accepts
  requests from that one origin). Set it back to `https://kingazzal69.github.io` before go-live.
- Note: the local page uses the real CRM data, same as the live site.

Stages (stop between each for Aaron's OK):
1. **Review only** — first Bulk SMS sign-in shows a QR code: scan it into an authenticator app
   straight away. Tick a few real clients → Review. Check names/numbers/messages. Don't send.
2. **One real SMS to Aaron** — n8n workflow ON; `SMS_TEST_ALLOWLIST` = Aaron's mobile; tick only a
   client with his number → Send. Check: text arrives with his first name, "1 of 1 accepted" on
   screen, Telegram summary arrives. Then in n8n open that execution → "Send via MobileMessage"
   output and confirm the "Map Provider Results" step matches MobileMessage's real reply shape
   (it was written from search summaries of their docs — the one unverified part).
3. **Small batch** — 2–5 numbers Aaron controls in the allowlist (include two clients sharing a
   number to see them merge).
4. **Go live** (only when Aaron says "push to live"): remove `SMS_TEST_ALLOWLIST`, set
   `CRM_ORIGIN` back, merge the branch to `main`, confirm GitHub Pages actually updated.

Rollback: switch the n8n workflow off (instant stop); optionally clear `SMS_ALLOWED_EMAILS`;
revert the bulk SMS commits on `main`. Keep the `bulk_sms_*` tables (send history).

## Parked ideas (not started)

- Import customers who unsubscribed in **ServiceM8** into the opt-out list (+ nightly sync in a new
  n8n workflow). Needs one known unsubscribed customer to find where ServiceM8 stores it.
- Auto-add "STOP" replies (via a MobileMessage dedicated number) to the opt-out list.
- Review-screen warning when a promo message has no opt-out line.
- Bulk templates with Aaron's "book now" link (ask which booking link he uses).
- Whole-CRM login + two-factor (bigger job, separate).
