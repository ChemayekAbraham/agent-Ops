DROP FUNCTION IF EXISTS public.get_partner_capital_projections(integer);

CREATE OR REPLACE FUNCTION public.get_partner_capital_projections(
  p_months integer DEFAULT 6,
  p_days integer DEFAULT NULL,
  p_bucket text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_bucket text := lower(coalesce(nullif(p_bucket,''), 'month'));
  v_days integer;
  v_months numeric;
  v_today date := (now() at time zone 'Africa/Kampala')::date;
  v_start date;
  v_step interval;
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

  if v_bucket not in ('day','week','month','year') then v_bucket := 'month'; end if;

  v_days := greatest(1, least(1826, coalesce(p_days, greatest(1, least(60, coalesce(p_months,6))) * 30)));
  v_months := v_days / 30.0;

  -- keep bucket count sane
  if v_bucket = 'day' and v_days > 120 then v_bucket := 'week'; end if;
  if v_bucket = 'week' and v_days > 400 then v_bucket := 'month'; end if;
  if v_bucket = 'month' and v_days > 1200 then v_bucket := 'year'; end if;

  v_step := case v_bucket when 'day' then interval '1 day'
                          when 'week' then interval '1 week'
                          when 'year' then interval '1 year'
                          else interval '1 month' end;
  v_start := date_trunc(case when v_bucket = 'day' then 'day' else v_bucket end, v_today::timestamp)::date;

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
           sum(case when a.is_compound then 0 else a.principal * a.r * v_months end) as projected_horizon_payout,
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
           round(pp.projected_horizon_payout) as projected_horizon_payout,
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
  b as (
    select row_number() over (order by gs) as idx,
           gs::date as bucket_start,
           least((gs + v_step)::date, (v_today + v_days)::date) as bucket_end
    from generate_series(v_start::timestamp, (v_today + v_days)::timestamp - interval '1 day', v_step) gs
  ),
  bm as (
    select b.idx, b.bucket_start, b.bucket_end,
           greatest(0, (greatest(b.bucket_start, v_today) - v_today))/30.0 as m_start,
           greatest(0, (b.bucket_end - v_today))/30.0 as m_end
    from b
  ),
  proj as (
    select bm.idx, bm.bucket_start, bm.bucket_end,
           round(sum(case when a.is_compound then 0
                          else a.principal * a.r * greatest(0, bm.m_end - bm.m_start) end)) as projected_roi_payout,
           round(sum(case when a.is_compound
                          then a.principal * (power(1 + a.r, bm.m_end) - power(1 + a.r, bm.m_start))
                          else 0 end)) as projected_compounding
    from bm cross join act a
    group by bm.idx, bm.bucket_start, bm.bucket_end
  ),
  notes as (
    select greatest(coalesce(n.next_deduction_date, v_today), v_today) as due_date,
           greatest(0, coalesce(n.amount,0) - coalesce(n.total_collected,0)) as expected
    from promissory_notes n
    where n.status in ('activated','pending','approved')
  ),
  notes_b as (
    select p.idx, coalesce(sum(n.expected),0) as expected
    from proj p
    left join notes n on n.due_date >= p.bucket_start and n.due_date < p.bucket_end
    group by p.idx
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'month', case v_bucket
                      when 'day' then to_char(p.bucket_start, 'DD Mon')
                      when 'week' then to_char(p.bucket_start, '"wk "DD Mon')
                      when 'year' then to_char(p.bucket_start, 'YYYY')
                      else to_char(p.bucket_start, 'Mon YY') end,
           'bucket_start', p.bucket_start,
           'projected_roi_payout', p.projected_roi_payout,
           'projected_compounding', p.projected_compounding,
           'promissory_expected', coalesce(nb.expected, 0)
         ) order by p.idx), '[]'::jsonb) into v_series
  from proj p
  left join notes_b nb on nb.idx = p.idx;

  select jsonb_build_object(
    'months', round(v_months, 2),
    'days', v_days,
    'bucket', v_bucket,
    'partner_count', (select count(*) from jsonb_array_elements(v_partners)),
    'deployed', (select coalesce(sum((e->>'deployed')::numeric),0) from jsonb_array_elements(v_partners) e),
    'projected_monthly_payout', (select coalesce(sum((e->>'projected_monthly_payout')::numeric),0) from jsonb_array_elements(v_partners) e),
    'projected_horizon_payout', (select coalesce(sum((e->>'projected_horizon_payout')::numeric),0) from jsonb_array_elements(v_partners) e),
    'projected_compound_growth', (select coalesce(sum((e->>'projected_compound_growth')::numeric),0) from jsonb_array_elements(v_partners) e),
    'promissory_expected', (select coalesce(sum((e->>'promissory_expected')::numeric),0) from jsonb_array_elements(v_series) e)
  ) into v_totals;

  return jsonb_build_object('partners', v_partners, 'series', v_series, 'totals', v_totals);
end;
$function$;

GRANT EXECUTE ON FUNCTION public.get_partner_capital_projections(integer, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_partner_capital_projections(integer, integer, text) TO service_role;