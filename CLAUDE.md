# Rapid Oven Cleaning CRM

Single-file CRM (`index.html`) for Rapid Oven Cleaning (Sydney oven/BBQ cleaning business, run by Aaron). No build step — it's one static HTML file with inline CSS/JS, deployed via **GitHub Pages** straight from `main` at https://kingazzal69.github.io/rapid-oven-crm/

## Deploy workflow

- Edit `index.html` directly, no build/bundler.
- Commit, then push to `origin main` — GitHub Pages redeploys automatically (usually 1-2 min).
- **Git identity:** no global git config is set on the dev machine. Commit with explicit env vars matching the existing author on this repo's history:
  `GIT_AUTHOR_NAME="Aaron" GIT_AUTHOR_EMAIL="accounts@rapidovencleaning.com" GIT_COMMITTER_NAME="Aaron" GIT_COMMITTER_EMAIL="accounts@rapidovencleaning.com" git commit -m "..."`
- **Deploy lag gotcha:** after pushing, the live site can take a minute+ to actually rebuild. If you write data (e.g. to Supabase) that depends on a just-pushed code change being live, verify the deploy landed first (poll the page for a string unique to the new code) — don't assume push = instantly live. This bit us once: a bulk data import ran before a Pipeline-filtering code fix had actually deployed, and briefly showed unfiltered data on the live site.
- Established convention with Aaron: commit when asked to "commit", but only `git push` when he explicitly says "push" / "make it live" / "push to live" — don't push on your own initiative for functional index.html changes. (Pure docs files like this one, with zero effect on the live rendered page, are fine to push directly.)

## Data layer — Supabase

- Project: `haarvltpfcbixqbwkxpl` (`https://haarvltpfcbixqbwkxpl.supabase.co`). URL + anon key are embedded directly in `index.html` (near the top of the `<script>` block) — the anon key has read/write on the `leads`/`projects`/`todos`/`config`/`staff_earnings` tables (RLS-scoped), so no separate credential is needed to inspect or write data via the REST API (`apikey` + `Authorization: Bearer <anon>` headers).
- **Tables:** `leads`, `projects`, `todos`, `config` (all shape `{id text, data jsonb, updated_at}` — the CRM reads/writes via `.select('*')` / `.upsert({id,data,updated_at},{onConflict:'id'})`), plus `staff_earnings` (used by the Square tab, written by a separate n8n workflow — see below).
- **Supabase caps any single select at 1000 rows.** `leads` now has 12k+ rows (see ServiceM8 import below), so the app pages through with `.range()` — see `fetchPaged()` / `fetchActiveLeadRows()` / `fetchArchivedLeadRows()` in `index.html`. If you add a new bulk-reading query anywhere, don't use a plain unbounded `.select('*')` — it will silently truncate at 1000 and can empty the Pipeline board (this happened once, see git history "Fix pipeline emptied by 1000-row Supabase select cap").

## Pipeline / leads data model

- A lead is `{id, name, phone, email, service, source, stage, value, suburb, address, notes, createdAt, followUp, jobDate, jobTime, assignedTo, history[], archived?, messaged?, d1?, d2?, d3?}`.
- `stage` is one of: `new`, `contacted`, `deadlead`, `followup`, `quoted`, `won`, `lost` (see `STAGES` array in `index.html`). `won`/`lost`/`deadlead` are terminal (see `TERMINAL_STAGES`) and excluded from the pipeline's happy-path advance arrow (see `STAGE_FLOW`) — `deadlead` ("Lost Lead") is for leads that went cold after contact, distinct from `lost` ("Closed — Lost") which is for quotes that didn't convert.
- `messaged`, `d1`, `d2`, `d3` are plain booleans toggled by the "msg"/"D1"/"D2"/"D3" checkboxes in the tracking row at the bottom of each Pipeline card (see `toggleFlag()`) — manual tick-off checkboxes for Aaron's own workflow (who's been texted, day-1/2/3 follow-up done), independent of stage. No stat/report currently reads them.
- **`archived: true`** marks a lead as historical/reference-only (currently: ~11.7k rows bulk-imported from ServiceM8's full job history, dated 2020–2026). Archived leads are deliberately excluded from the live Pipeline board, stat tiles, and Map (see `activeLeads()` helper) — they only show up in the Clients Database table (lazy-loaded on that tab) and CSV export. **Keep this separation if you touch board/stats/map rendering** — Aaron was very explicit that historical bulk data must never pollute the live working pipeline.
- Names sync in from ServiceM8 as `"Last, First"` (e.g. `"Bowman, Trudy"`), while manual/seed leads are `"First Last"`. Use the `firstNameOf()` helper (handles both) rather than a naive `split(' ')[0]` anywhere you need a first name — this was a real bug (SMS templates were greeting people by surname).

## SMS follow-up templates

- `tpls` array (near the top of the `<script>` block) holds canned SMS templates with `{name}`/`{service}`/`{value}`/`{suburb}`/`{address}`/`{jobwhen}` placeholders. Editable in the lead modal's Follow-up section, or directly in code (no saved Supabase `config` row exists yet as of writing, so the hardcoded array in `index.html` **is** the live version — check the `config` table first if editing, in case that's changed).
- `pickTplForStage(stage)` maps pipeline stage → template index for the **quick-SMS 💬 button** that sits on every Pipeline card (opens the phone's native SMS app via an `sms:` URI with the message pre-filled). Keep this mapping in sync if templates are added/reordered.
- Business voice: texts are signed from "Brenna" at Rapid Oven Cleaning — casual, short, no corporate tone.

## Integrations this CRM depends on (external, not in this repo)

- **n8n → Supabase sync** (self-hosted n8n on a Hostinger VPS): pulls ServiceM8 jobs and upserts them into the `leads` table on a schedule, keyed `sm8_<job_uuid>`. This is what keeps New Leads etc. flowing in live. Full architecture/history is in Aaron's Claude memory (`n8n-servicem8-crm-sync`), not in this repo.
- **Square → staff_earnings sync**: separate n8n workflow, feeds the Square tab (per-staff commission/cash tracking).
- **ServiceM8 → CRM one-time historical backfill**: already done (Sept 2026) — ~11.7k historical jobs imported as `archived:true` rows with id prefix `sm8hist_<job_uuid>` (distinct from the live sync's `sm8_` prefix, specifically so it's easy to bulk-identify/remove if ever needed and can't collide with the live incremental sync).
- **Zapier**: Gmail/Meta leads → ServiceM8 clients (separate from this CRM entirely). Aaron has an explicit standing rule: never edit his existing Zapier/Pipedrive/Meta assets without naming the change and getting confirmation first — these are live business infrastructure he depends on daily.

## Things to be careful with

- This is Aaron's real, daily-used business tool — every change here is effectively "in production" the moment it's pushed. No staging environment.
- Files outside a Claude session's own project folder render as a **static snapshot** in some sandboxed browser-preview tools (no live JS) — don't assume a preview screenshot means the code actually ran; verify logic by careful reading + a real deploy check when a true headless browser isn't available.
- No test suite, no linter, no build — verify changes by reading the diff carefully (brace/paren balance is a cheap sanity check for template-literal-heavy edits) and, where possible, exercising the actual live site or the Supabase REST API directly.
