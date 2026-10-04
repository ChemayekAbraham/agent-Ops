create or replace function public.get_partner_capital_projections(p_months integer default 6)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_months integer := greatest(1, least(24, coalesce(p_months, 6)));
  v_partners jsonb;
  v_series jsonb;
  v_totals jsonb;
begin
  if not (
    has_role(auth.uid(), 'cfo') or has_role(auth.uid(), 'coo') or has_role(auth.uid(), 'ceo')
    or has_role(auth.uid(), 'manager') or has_role(auth.uid(), 'super_admin')
    or has_role(auth.uid(), 'partner_ops') or has_role(auth.uid(), 'financial_ops')
    or has_role(auth.uid(), 'operations')
  ) then
    raise exception 'not authorized';
  end if;

  with act as (
    select p.*,
           coalesce(p.investor_id, p.agent_id) as owner_id,
           case when lower(coalesce(p.roi_mode,'')) like '%compound%' then true else false end as is_compound,
           coalesce(p.investment_amount,0) as principal,
           coalesce(p.roi_percentage,0)/100.0 as r
    from investor_portfolios p
    where p.status = 'active'
  ),
  per_partner as (
    select a.owner_id,
           count(*) as portfolios,
           sum(a.principal) as deployed,
           sum(case when a.is_compound then a.principal else 0 end) as compounding_deployed,
           sum(case when a.is_compound then 0 else a.principal end) as payout_deployed,
           sum(a.principal * a.r) as expected_monthly_return,
           sum(case when a.is_compound then 0 else a.principal * a.r end) as projected_monthly_payout,
           sum(case when a.is_compound
                    then a.principal * (power(1 + a.r, v_months) - 1)
                    else 0 end) as projected_compound_growth,
           sum(coalesce(a.total_roi_earned,0)) as roi_earned_to_date,
           min(a.next_roi_date) as next_roi_date,
           max(a.roi_percentage) as top_rate
    from act a
    group by a.owner_id
  )
  select coalesce(jsonb_agg(x order by x.deployed desc), '[]'::jsonb) into v_partners
  from (
    select pp.owner_id as partner_id,
           coalesce(pr.full_name, pr.email, 'Unknown partner') as partner_name,
           pr.phone,
           pp.portfolios, pp.deployed, pp.compounding_deployed, pp.payout_deployed,
           round(pp.expected_monthly_return) as expected_monthly_return,
           round(pp.projected_monthly_payout) as projected_monthly_payout,
           round(pp.projected_compound_growth) as projected_compound_growth,
           pp.roi_earned_to_date, pp.next_roi_date, pp.top_rate
    from per_partner pp
    left join profiles pr on pr.id = pp.owner_id
  ) x;

  with act as (
    select coalesce(p.investment_amount,0) as principal,
           coalesce(p.roi_percentage,0)/100.0 as r,
           case when lower(coalesce(p.roi_mode,'')) like '%compound%' then true else false end as is_compound
    from investor_portfolios p
    where p.status = 'active'
  ),
  m as (
    select gs as idx, date_trunc('month', (now() at time zone 'Africa/Kampala') + make_interval(months => gs - 1))::date as month_start
    from generate_series(1, v_months) gs
  ),
  proj as (
    select m.idx, m.month_start,
           round(sum(case when a.is_compound then 0 else a.principal * a.r end)) as projected_roi_payout,
           round(sum(case when a.is_compound
                          then a.principal * (power(1 + a.r, m.idx) - power(1 + a.r, m.idx - 1))
                          else 0 end)) as projected_compounding
    from m cross join act a
    group by m.idx, m.month_start
  ),
  notes as (
    select date_trunc('month', coalesce(n.next_deduction_date, (now() at time zone 'Africa/Kampala')::date))::date as month_start,
           sum(greatest(0, coalesce(n.amount,0) - coalesce(n.total_collected,0))) as expected
    from promissory_notes n
    where n.status in ('activated','pending','approved')
    group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'month', to_char(p.month_start, 'Mon YY'),
           'projected_roi_payout', p.projected_roi_payout,
           'projected_compounding', p.projected_compounding,
           'promissory_expected', coalesce(nz.expected, 0)
         ) order by p.idx), '[]'::jsonb) into v_series
  from proj p
  left join (
    select case when n.month_start < date_trunc('month', (now() at time zone 'Africa/Kampala'))::date
                then date_trunc('month', (now() at time zone 'Africa/Kampala'))::date
                else n.month_start end as month_start,
           sum(n.expected) as expected
    from notes n group by 1
  ) nz on nz.month_start = p.month_start;

  select jsonb_build_object(
    'months', v_months,
    'partner_count', (select count(*) from jsonb_array_elements(v_partners)),
    'deployed', (select coalesce(sum((e->>'deployed')::numeric),0) from jsonb_array_elements(v_partners) e),
    'projected_monthly_payout', (select coalesce(sum((e->>'projected_monthly_payout')::numeric),0) from jsonb_array_elements(v_partners) e),
    'projected_compound_growth', (select coalesce(sum((e->>'projected_compound_growth')::numeric),0) from jsonb_array_elements(v_partners) e),
    'promissory_expected', (select coalesce(sum((e->>'promissory_expected')::numeric),0) from jsonb_array_elements(v_series) e)
  ) into v_totals;

  return jsonb_build_object('partners', v_partners, 'series', v_series, 'totals', v_totals);
end;
$$;

revoke all on function public.get_partner_capital_projections(integer) from public;
grant execute on function public.get_partner_capital_projections(integer) to authenticated;