-- SMS Forwarder (Android app) — phase 1: SHADOW intake.
-- The phone uploads raw MoMo SMS straight to sms-forwarder-ingest. In shadow
-- mode nothing here posts money: rows are stored, parsed with the shared
-- parser and compared against gmail_transactions (the IFTTT→Gmail path).
-- Service role only; devices authenticate with a hashed bearer token.

create table if not exists public.sms_forwarder_devices (
  id uuid primary key default gen_random_uuid(),
  label text not null,                       -- e.g. "MTN phone – Kampala HQ"
  token_hash text not null unique,           -- sha256 hex of the bearer token
  sim_label text,                            -- operator note: which SIM/number
  mode text not null default 'shadow' check (mode in ('shadow','live')),
  active boolean not null default true,
  last_seen_at timestamptz,
  last_battery_pct int,
  last_app_version text,
  last_pending_count int,
  last_heartbeat jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.sms_forwarder_messages (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.sms_forwarder_devices(id) on delete cascade,
  client_message_id text not null,           -- stable id minted on the phone (sha256 of sender|ts|body)
  sender text not null,                      -- originating address, e.g. "MTNMobMoney"
  body text not null,                        -- COMPLETE original SMS
  sms_received_at timestamptz not null,      -- timestamp from the phone's SMS provider
  sim_slot int,
  uploaded_at timestamptz not null default now(),
  attempt_count int not null default 1,
  -- parsed with _shared/txnParser.ts
  parsed boolean not null default false,
  amount numeric,
  transaction_id text,
  direction text,
  channel text,
  counterparty text,
  counterparty_name text,
  fee numeric,
  balance numeric,
  -- shadow comparison against gmail_transactions
  comparison text not null default 'pending'
    check (comparison in ('pending','matched_gmail','phone_only','unparsed','not_transaction')),
  matched_gmail_row_id uuid,
  compared_at timestamptz,
  unique (device_id, client_message_id)
);

create index if not exists sms_forwarder_messages_tid_idx
  on public.sms_forwarder_messages (lower(transaction_id)) where transaction_id is not null;
create index if not exists sms_forwarder_messages_cmp_idx
  on public.sms_forwarder_messages (comparison, sms_received_at desc);

alter table public.sms_forwarder_devices enable row level security;
alter table public.sms_forwarder_messages enable row level security;
-- no policies: service role only.

-- Coverage report for the shadow period: how many parsed money SMS did the
-- phone see that Gmail did NOT (phone_only = IFTTT losses), and the reverse.
create or replace function public.sms_forwarder_shadow_coverage(p_hours int default 24)
returns jsonb
language sql
security definer
set search_path = public
as $$
  with m as (
    select * from sms_forwarder_messages
    where sms_received_at >= now() - make_interval(hours => greatest(1, least(p_hours, 720)))
  ), g as (
    select transaction_id from gmail_transactions
    where internal_date >= now() - make_interval(hours => greatest(1, least(p_hours, 720)))
      and transaction_id is not null
  )
  select jsonb_build_object(
    'window_hours', p_hours,
    'phone_messages', (select count(*) from m),
    'phone_parsed', (select count(*) from m where parsed),
    'matched_gmail', (select count(*) from m where comparison = 'matched_gmail'),
    'phone_only', (select count(*) from m where comparison = 'phone_only'),
    'gmail_only_tids', (
      select count(distinct g.transaction_id) from g
      where not exists (select 1 from sms_forwarder_messages s
                        where lower(s.transaction_id) = lower(g.transaction_id))
    ),
    'phone_only_tids', (
      select coalesce(jsonb_agg(transaction_id), '[]'::jsonb)
      from (select transaction_id from m where comparison = 'phone_only' limit 50) x
    )
  );
$$;
revoke all on function public.sms_forwarder_shadow_coverage(int) from public, anon, authenticated;
grant execute on function public.sms_forwarder_shadow_coverage(int) to service_role;
