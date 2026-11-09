-- agent_onboarded_portfolios() returned 1,315 rows for a proxy agent with 836 partners (Kabahuma Lillian), and PostgREST cuts any
-- response at 1,000 rows (her API log: content-range 0-999). The rows were ordered by created_at, so 22 of the 30 portfolios that
-- have an open CFO-approved ROI payout fell past row 1,000. ProxyPartnerFunds maps each approved payout to a partner through this
-- list and drops any payout it cannot map, so "No proxy partner payouts ready" showed although get_agent_proxy_roi_payouts returned
-- 32 rows. (Introduced by 20261105130000, which lifted the old 200-row cap to 5000 without considering the API row limit.)
-- Change: order by relevance so the portfolios the screen needs come first, then everything else:
--   0  portfolios with an open approved ROI payout for the caller (get_agent_proxy_roi_payouts)
--   1  portfolios of partners in the caller's 500 newest proxy withdrawals (names for Recent payouts)
--   2  every other portfolio the caller may see        3  placeholder rows for assigned partners with no portfolio
-- Same columns, same rows, same masking and grants. The 5000 cap stays; callers that need more than 1,000 must page.
-- Rollback: 20261105181000_agent_onboarded_portfolios_priority_order.rollback.sql (restores 20261105130000)
-- critical_function_baselines: no entry for this function (checked 2026-11-05).

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
  with me as (select (select auth.uid()) as uid),
  open_ports as (
    select distinct r.source_id
    from me, public.get_agent_proxy_roi_payouts(me.uid) r
    where me.uid is not null and r.source_id is not null
  ),
  recent_partners as (
    select distinct coalesce(w.proxy_partner_id, w.linked_party, w.user_id) as pid
    from (
      select x.proxy_partner_id, x.linked_party, x.user_id
      from public.withdrawal_requests x, me
      where me.uid is not null
        and (x.agent_id = me.uid or x.initiated_by = me.uid)
        and (x.proxy_partner_id is not null or x.linked_party is not null)
      order by x.created_at desc
      limit 500
    ) w
  )
  select t.portfolio_id, t.investor_id, t.partner_name, t.portfolio_code_masked, t.investment_amount, t.total_roi_earned,
    t.roi_percentage, t.duration_months, t.status, t.created_at, t.next_roi_date, t.maturity_date
  from (
    select case
        when p.id in (select source_id from open_ports) then 0
        when p.investor_id in (select pid from recent_partners) then 1
        else 2
      end as prio,
      p.id as portfolio_id,
      p.investor_id as investor_id,
      coalesce(pr.full_name, 'Partner') as partner_name,
      case
        when p.portfolio_code is null or length(p.portfolio_code) <= 4 then '****'
        else substr(p.portfolio_code, 1, 3) || repeat('*', greatest(length(p.portfolio_code) - 5, 2)) || right(p.portfolio_code, 2)
      end as portfolio_code_masked,
      p.investment_amount as investment_amount,
      coalesce(p.total_roi_earned, 0) as total_roi_earned,
      p.roi_percentage as roi_percentage,
      p.duration_months as duration_months,
      p.status::text as status,
      p.created_at as created_at,
      p.next_roi_date::date as next_roi_date,
      p.maturity_date::date as maturity_date
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
    select 3,
      null::uuid,
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
  ) t
  order by t.prio, t.created_at desc
  limit 5000
$$;

revoke all on function public.agent_onboarded_portfolios() from public, anon;
grant execute on function public.agent_onboarded_portfolios() to authenticated, service_role;
