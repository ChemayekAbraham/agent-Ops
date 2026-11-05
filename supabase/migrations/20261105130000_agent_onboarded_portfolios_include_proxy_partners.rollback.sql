-- Restores the 20261104244000 definition (agent_id portfolios only + placeholder rows, cap 200).
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
  join me on p.agent_id = me.uid
  left join public.profiles pr on pr.id = p.investor_id
  where me.uid is not null
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
  order by created_at desc
  limit 200
$$;

revoke all on function public.agent_onboarded_portfolios() from public, anon;
grant execute on function public.agent_onboarded_portfolios() to authenticated, service_role;
