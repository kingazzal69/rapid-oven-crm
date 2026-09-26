# Bulk SMS — handover (where we're up to)

Last updated 2026-09-26. **Bulk SMS is LIVE** — merged to `main` from branch
`claude/brave-thompson-1me8tr` on 2026-09-26 at Aaron's request ("go live"). Read `CLAUDE.md` and
`supabase/functions/bulk-sms/SETUP.md` before changing anything.

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
- Git: commit as `Aaron <accounts@rapidovencleaning.com>` (see CLAUDE.md); push to `main` only when
  Aaron explicitly says so.

## Live configuration (Supabase project `haarvltpfcbixqbwkxpl`)

- **Tables:** `supabase/migrations/0001_bulk_sms.sql` applied 2026-09-26 — 5 `bulk_sms_*` tables,
  RLS on with zero policies. Verified: the public anon key reads 0 rows and inserts are refused.
  (Note: Supabase's default privileges *do* grant anon/authenticated on new public tables — RLS is
  what actually blocks them, not a lack of grants.)
- **Login:** `leadsroc@gmail.com` (Auto Confirm), TOTP two-factor enrolled. Sign-ups setting left
  **on** (unchanged — Aaron hasn't decided; the CRM has no `signUp` call).
- **Edge Function `bulk-sms`:** deployed from the dashboard editor (byte-identical to
  `supabase/functions/bulk-sms/index.ts` at `ea64db2`), Verify JWT **on**.
- **Secrets:** `SMS_ALLOWED_EMAILS=leadsroc@gmail.com`, `N8N_SMS_WEBHOOK_URL`,
  `N8N_SMS_WEBHOOK_SECRET` (Aaron typed; matches n8n), `CRM_ORIGIN=https://kingazzal69.github.io`.
  `SMS_TEST_ALLOWLIST` **deleted** at go-live.
- **n8n** workflow "Rapid Oven – Bulk SMS (MobileMessage)" (`aRcdRb22RQCmPK5C`) **published (on)**.
  Telegram bot: @Smsbulkrocbot. The other 10 workflows were checked unchanged after testing.
- **Bulk templates** (`bulk_sms_templates`): "—" replaced with "-" and curly ’ with ' in all
  template texts (MobileMessage silently drops non-GSM characters — the first test text came out
  as "see you then  if…"). Keep new bulk templates to plain characters.

## Testing done (2026-09-26, all passed)

1. **Review only** — sign-in + TOTP enrolment; non-allowlisted clients blocked with the test-mode
   message; "Send 0 texts" disabled.
2. **One real text** to Aaron — received; "1 of 1 accepted"; Telegram summary received.
   **MobileMessage's real reply shape confirmed:** `{status:"complete", total_cost, send_id,
   results:[{to, message, sender, custom_ref, status:"success", cost, message_id}]}` — the
   "Map Provider Results" step handles it correctly (no change needed).
3. **Small batch** — 7 ticked records across 3 numbers Aaron controls → 3 texts, each recorded
   against every record sharing its number; each sent exactly once; "3 of 3 accepted".
   Not yet exercised live: the "Shared numbers" conflict picker (two names on one number) —
   covered by the automated tests; can be checked any time with Review only.

Gotcha: pressing **Send** opens a browser `confirm()` popup. If Chrome is suppressing dialogs for the
tab, Send silently does nothing — reload the tab / open a fresh one.

## Rollback

Switch the n8n workflow off (instant stop); optionally clear `SMS_ALLOWED_EMAILS`; revert the bulk
SMS commits on `main`. Keep the `bulk_sms_*` tables (send history). To test again safely, re-add
`SMS_TEST_ALLOWLIST` (and set `CRM_ORIGIN=http://localhost:8000` for a local copy).

## Known issue found during setup (NOT bulk-SMS related, not fixed)

RLS is **disabled** on `leads`, `config`, `projects`, `todos` — anyone with the anon key embedded
in the public `index.html` can read all ~13.5k leads (names, phones, addresses). Fixing it needs
RLS policies that keep the CRM working (it uses the anon key with no login). Separate, careful job.

## Parked ideas (not started)

- Import customers who unsubscribed in **ServiceM8** into the opt-out list (+ nightly sync in a new
  n8n workflow). Needs one known unsubscribed customer to find where ServiceM8 stores it.
- Auto-add "STOP" replies (via a MobileMessage dedicated number) to the opt-out list.
- Review-screen warning when a promo message has no opt-out line.
- Review-screen warning for non-GSM characters (—, ’, emoji) that MobileMessage would drop.
- Bulk templates with Aaron's "book now" link (ask which booking link he uses).
- Whole-CRM login + two-factor (bigger job, separate).
