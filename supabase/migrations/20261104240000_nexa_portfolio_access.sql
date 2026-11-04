-- Nexa partner portfolio access (read only). Approved design, 4 Nov 2026.
-- Adds: own-portfolio read fn, OTP verification tables for non-signed-in callers, audit log.
-- Rollback (manual): drop function public.nexa_get_my_portfolios(); drop function public.nexa_get_portfolio_by_id(uuid);
--   drop function public.nexa_portfolio_otp_target(text); drop table public.nexa_portfolio_sessions, public.nexa_portfolio_otp_challenges, public.nexa_portfolio_access_audit;

-- 1. Signed-in caller: own portfolios only, identity from auth.uid(). No arguments by design.
create or replace function public.nexa_get_my_portfolios()
returns table (portfolio_code text, investment_amount numeric, roi_mode text, roi_percentage numeric,
  next_roi_date date, maturity_date date, total_roi_earned numeric, current_value numeric, status text)
language sql stable security definer set search_path = public as $$
  select p.portfolio_code::text, p.investment_amount::numeric, p.roi_mode::text, p.roi_percentage::numeric,
    p.next_roi_date::date, p.maturity_date::date, coalesce(p.total_roi_earned,0)::numeric,
    (p.investment_amount + case when p.roi_mode::text ilike '%compound%' then coalesce(p.total_roi_earned,0) else 0 end)::numeric,
    p.status::text
  from public.investor_portfolios p
  where (select auth.uid()) is not null and p.investor_id = (select auth.uid())
    and p.status::text not in ('cancelled')
  order by p.created_at desc limit 50
$$;
revoke all on function public.nexa_get_my_portfolios() from public, anon;
grant execute on function public.nexa_get_my_portfolios() to authenticated, service_role;

-- 2. OTP-verified session (server only): one portfolio by id.
create or replace function public.nexa_get_portfolio_by_id(p_portfolio_id uuid)
returns table (portfolio_code text, investment_amount numeric, roi_mode text, roi_percentage numeric,
  next_roi_date date, maturity_date date, total_roi_earned numeric, current_value numeric, status text)
language sql stable security definer set search_path = public as $$
  select p.portfolio_code::text, p.investment_amount::numeric, p.roi_mode::text, p.roi_percentage::numeric,
    p.next_roi_date::date, p.maturity_date::date, coalesce(p.total_roi_earned,0)::numeric,
    (p.investment_amount + case when p.roi_mode::text ilike '%compound%' then coalesce(p.total_roi_earned,0) else 0 end)::numeric,
    p.status::text
  from public.investor_portfolios p where p.id = p_portfolio_id
$$;
revoke all on function public.nexa_get_portfolio_by_id(uuid) from public, anon, authenticated;
grant execute on function public.nexa_get_portfolio_by_id(uuid) to service_role;

-- 3. OTP target lookup (server only): portfolio id + phone on file. Never exposed to clients.
create or replace function public.nexa_portfolio_otp_target(p_portfolio_code text)
returns table (portfolio_id uuid, investor_id uuid, phone text)
language sql stable security definer set search_path = public as $$
  select p.id, p.investor_id, pr.phone::text
  from public.investor_portfolios p join public.profiles pr on pr.id = p.investor_id
  where upper(p.portfolio_code) = upper(p_portfolio_code)
    and p.status::text not in ('cancelled','redeemed')
    and coalesce(pr.phone,'') <> ''
  limit 1
$$;
revoke all on function public.nexa_portfolio_otp_target(text) from public, anon, authenticated;
grant execute on function public.nexa_portfolio_otp_target(text) to service_role;

-- 4. Tables: service role only (RLS on, no client policies).
create table if not exists public.nexa_portfolio_otp_challenges (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.investor_portfolios(id) on delete cascade,
  otp_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  locked_until timestamptz,
  consumed_at timestamptz,
  ip_hash text,
  created_at timestamptz not null default now()
);
create index if not exists nexa_otp_ch_portfolio_idx on public.nexa_portfolio_otp_challenges(portfolio_id, created_at desc);

create table if not exists public.nexa_portfolio_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  portfolio_id uuid not null references public.investor_portfolios(id) on delete cascade,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.nexa_portfolio_access_audit (
  id bigserial primary key,
  event text not null,
  portfolio_id uuid,
  challenge_id uuid,
  code_hash text,
  ip_hash text,
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists nexa_audit_ip_idx on public.nexa_portfolio_access_audit(ip_hash, created_at desc);
create index if not exists nexa_audit_code_idx on public.nexa_portfolio_access_audit(code_hash, created_at desc);
create index if not exists nexa_audit_portfolio_idx on public.nexa_portfolio_access_audit(portfolio_id, created_at desc);

alter table public.nexa_portfolio_otp_challenges enable row level security;
alter table public.nexa_portfolio_sessions enable row level security;
alter table public.nexa_portfolio_access_audit enable row level security;

revoke all on public.nexa_portfolio_otp_challenges, public.nexa_portfolio_sessions, public.nexa_portfolio_access_audit from anon, authenticated, public;
grant all on public.nexa_portfolio_otp_challenges, public.nexa_portfolio_sessions, public.nexa_portfolio_access_audit to service_role;
grant usage, select on sequence public.nexa_portfolio_access_audit_id_seq to service_role;

-- Staff MFA is a no-op until staff_mfa_config.mode is admin or all. No client policies grant rows.
drop policy if exists mfa_required_for_staff on public.nexa_portfolio_otp_challenges;
create policy mfa_required_for_staff on public.nexa_portfolio_otp_challenges as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));
drop policy if exists mfa_required_for_staff on public.nexa_portfolio_sessions;
create policy mfa_required_for_staff on public.nexa_portfolio_sessions as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));
drop policy if exists mfa_required_for_staff on public.nexa_portfolio_access_audit;
create policy mfa_required_for_staff on public.nexa_portfolio_access_audit as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));
