-- Bulk SMS storage — additive only. Does not alter leads/projects/todos/config
-- tables, policies or triggers. No grants to anon/authenticated: every table
-- here is reached only through the bulk-sms Edge Function using the service
-- role key, which enforces the SMS_ALLOWED_EMAILS allowlist itself. RLS is
-- enabled with zero policies as a second, defense-in-depth deny-all layer in
-- case a grant is ever added by mistake.

create extension if not exists pgcrypto;

create table if not exists bulk_sms_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  text text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One-time seed marker so re-running setup never overwrites edited templates.
create table if not exists bulk_sms_migration_markers (
  key text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists bulk_sms_suppressions (
  id uuid primary key default gen_random_uuid(),
  canonical_number text not null unique,
  reason text not null default 'manual',
  lead_id text,
  created_at timestamptz not null default now(),
  created_by text not null
);

create table if not exists bulk_sms_batches (
  id uuid primary key default gen_random_uuid(),
  -- Client-supplied idempotency key, persisted durably in the browser (not
  -- just an in-memory variable) so a reload/reopen can't spawn a second batch
  -- for the same prepared send.
  client_batch_key text not null unique,
  payload_hash text not null,
  template_id uuid references bulk_sms_templates(id),
  template_name_snapshot text,
  requested_by text not null,
  status text not null default 'prepared'
    check (status in ('prepared','submitting','accepted','confirmed_failed','unknown')),
  recipient_count integer not null,
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  resolved_at timestamptz
);

create table if not exists bulk_sms_recipients (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references bulk_sms_batches(id) on delete cascade,
  -- Deterministic per-recipient idempotent id (batch_id + canonical number),
  -- so a retried submit claims the same row instead of inserting a duplicate.
  operation_id text not null unique,
  canonical_number text not null,
  message text not null,
  -- Every checked client ID that resolved to this unique number, kept for
  -- audit and so a successful send can be reconciled back to each of them.
  lead_ids text[] not null,
  status text not null default 'prepared'
    check (status in ('prepared','submitting','accepted','confirmed_failed','unknown')),
  delivery_status text
    check (delivery_status is null or delivery_status in ('unknown','delivered','failed')),
  provider_message_id text,
  provider_response jsonb,
  attempt_count integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, canonical_number)
);

create index if not exists bulk_sms_recipients_batch_id_idx on bulk_sms_recipients(batch_id);
create index if not exists bulk_sms_recipients_status_idx on bulk_sms_recipients(status);

alter table bulk_sms_templates enable row level security;
alter table bulk_sms_migration_markers enable row level security;
alter table bulk_sms_suppressions enable row level security;
alter table bulk_sms_batches enable row level security;
alter table bulk_sms_recipients enable row level security;
