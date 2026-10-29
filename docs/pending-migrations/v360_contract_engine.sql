-- APPLIED 2026-10-29 (Benjamin approved), corrected version applied via migration tool; kept for reference.
-- This project has one connected database (production). Apply only after explicit approval.
-- Existing plans are untouched: every new column defaults to legacy behaviour.

-- 1. Versioning and roll-forward counters
alter table public.rent_requests
  add column if not exists pricing_version text not null default 'legacy',
  add column if not exists v360_daily_rate numeric,
  add column if not exists v360_gross numeric,
  add column if not exists v360_receivable numeric,
  add column if not exists v360_paid_days integer not null default 0,
  add column if not exists v360_missed_days integer not null default 0,
  add column if not exists v360_vacant_days integer not null default 0,
  add column if not exists v360_started_on date,
  add column if not exists v360_maturity_on date
    generated always as (v360_started_on + 360 + v360_missed_days + v360_vacant_days) stored;

-- 2. Pricing (mirrors src/lib/contractEngine360.ts)
create or replace function public.compute_rent_repayment_v360(p_principal numeric, p_months int default 1)
returns jsonb language sql immutable set search_path = public as $$
  with g as (
    select ceil((p_principal * power(1.15, p_months)
                 + greatest(3500 * p_months, 0.025 * p_months * p_principal))
                / (0.90 - 0.07 * p_months)) as gross
  )
  select jsonb_build_object(
    'pricing_version', 'v360',
    'gross', gross,
    'daily', ceil(gross / (30 * p_months)),
    'partner_monthly', round(p_principal * 0.15),
    'partner_12_months', round(p_principal * 0.15) * 12,
    'agent', round(gross * 0.10),
    'rail', greatest(3500 * p_months, 0.025 * p_months * p_principal),
    'welile', round(gross * 0.07),
    'receivable_360', 360 * ceil(gross / (30 * p_months)))
  from g;
$$;
grant execute on function public.compute_rent_repayment_v360(numeric, int) to authenticated;

-- 3. Buffer pool (A_buffer): Unit 7 Financial Ops reserve.
-- Seed approach: a CFO-approved transfer from Welile's own retained share into this pool
-- via create_ledger_transaction (category to be added to the allowlist). Never from Partner capital.
create table if not exists public.v360_buffer_draws (
  id uuid primary key default gen_random_uuid(),
  rent_request_id uuid not null references public.rent_requests(id),
  cycle_no int not null,
  amount numeric not null check (amount >= 0),
  ledger_reference text,
  created_at timestamptz not null default now(),
  unique (rent_request_id, cycle_no)
);
grant select on public.v360_buffer_draws to authenticated;
grant all on public.v360_buffer_draws to service_role;
alter table public.v360_buffer_draws enable row level security;
create policy v360_buffer_draws_cfo_read on public.v360_buffer_draws for select to authenticated
  using ((select has_role((select auth.uid()), 'cfo'::app_role)));
create policy mfa_required_for_staff on public.v360_buffer_draws as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));

-- 4. Agent roll-forward actions (append one day per call, emits system_event)
create or replace function public.v360_mark_day(p_rent_request_id uuid, p_kind text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.rent_requests;
begin
  if p_kind not in ('vacant', 'missed') then raise exception 'Unknown day type'; end if;
  if length(coalesce(trim(p_reason), '')) < 10 then raise exception 'Reason must be at least 10 characters'; end if;
  select * into r from public.rent_requests where id = p_rent_request_id for update;
  if r.id is null or r.pricing_version <> 'v360' then raise exception 'Not a 360-day Rent Plan'; end if;
  if r.agent_id is distinct from (select auth.uid()) then raise exception 'Only the assigned agent can do this'; end if;
  update public.rent_requests
     set v360_vacant_days = v360_vacant_days + (p_kind = 'vacant')::int,
         v360_missed_days = v360_missed_days + (p_kind = 'missed')::int
   where id = p_rent_request_id;
  -- system_events insert and audit_logs row to follow the project's standard helpers.
  return jsonb_build_object('success', true);
end $$;
revoke all on function public.v360_mark_day(uuid, text, text) from public, anon;
grant execute on function public.v360_mark_day(uuid, text, text) to authenticated;

-- 5. Still to write before approval (needs CFO review of ledger categories):
--   post_v360_daily_waterfall (Partner escrow, Landlord principal, Rail, Agent 10% on cash, Welile 7%),
--   activation schedules (12 Partner Returns rows, 12 Landlord payout rows),
--   Day-30 job drawing v360_buffer_draws when short, statement RPC mappings to the 7 Operating Units.
