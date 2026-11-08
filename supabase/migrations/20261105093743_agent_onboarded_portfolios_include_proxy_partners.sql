-- Proxy agents must see the portfolios of the partners they are assigned to, not only portfolios where
-- they are investor_portfolios.agent_id.
-- Problem: agent_onboarded_portfolios() returned only portfolios with agent_id = caller, plus one placeholder row
-- (portfolio_id NULL) per active assignment, capped at 200. A proxy agent (Kabahuma Lillian: 836 active partners,
-- 1,281 portfolios, 2 with her as agent_id) therefore got 200 placeholders and no real portfolio, so
-- ProxyPartnerFunds could not map any approved ROI payout to a partner and showed "No proxy partner payouts ready"
-- (77 approved payouts hidden) and "Name not available".
-- Change: also return portfolios whose investor is a partner of an active, approved assignment to the caller;
-- raise the cap from 200 to 5000. Same columns, same masked code, no payout numbers.
-- Rollback: 20261105130000_agent_onboarded_portfolios_include_proxy_partners.rollback.sql
-- critical_function_baselines: no entry for this function (checked 2026-11-05), so no re-baseline.

create or replace function public.agent_onboarded_portfolios()
returns table (
  portfolio_id uuid,
  investor_id uuid,
  partner_name text,
  portfolio_code_masked text,
  investment_amount numeric,
  total_roi_earned numeric,
  roi_percentage numeric,
  duration_months integer,
  status text,
  created_at timestamptz,
  next_roi_date date,
  maturity_date date
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (select (select auth.uid()) as uid)
  select p.id,
    p.investor_id,
    coalesce(pr.full_name, 'Partner'),
    case
      when p.portfolio_code is null or length(p.portfolio_code) <= 4 then '****'
      else substr(p.portfolio_code, 1, 3) || repeat('*', greatest(length(p.portfolio_code) - 5, 2)) || right(p.portfolio_code, 2)
    end,
    p.investment_amount,
    coalesce(p.total_roi_earned, 0),
    p.roi_percentage,
    p.duration_months,
    p.status::text,
    p.created_at,
    p.next_roi_date::date,
    p.maturity_date::date
  from public.investor_portfolios p
  join me on me.uid is not null
  left join public.profiles pr on pr.id = p.investor_id
  where p.agent_id = me.uid
     or exists (
       select 1 from public.proxy_agent_assignments a
       where a.agent_id = me.uid
         and a.beneficiary_id = p.investor_id
         and a.is_active = true
         and a.approval_status = 'approved'
     )
  union all
  select null::uuid,
    a.beneficiary_id,
    coalesce(pr.full_name, 'Partner'),
    null::text,
    0::numeric,
    0::numeric,
    null::numeric,
    null::integer,
    coalesce(a.approval_status, 'pending'),
    a.created_at,
    null::date,
    null::date
  from public.proxy_agent_assignments a
  join me on a.agent_id = me.uid
  left join public.profiles pr on pr.id = a.beneficiary_id
  where me.uid is not null
    and a.is_active = true
    and not exists (
      select 1 from public.investor_portfolios p
      where p.agent_id = a.agent_id and p.investor_id = a.beneficiary_id
    )
    and not exists (
      select 1 from public.investor_portfolios p
      where p.investor_id = a.beneficiary_id
        and a.approval_status = 'approved'
    )
  order by created_at desc
  limit 5000
$$;

revoke all on function public.agent_onboarded_portfolios() from public, anon;
grant execute on function public.agent_onboarded_portfolios() to authenticated, service_role;
