create or replace function public.tppo_period_plan_detail(
  p_granularity text,
  p_anchor date default null
)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_anchor date := coalesce(p_anchor, (now() at time zone 'Africa/Kampala')::date);
  v_start date; v_end date; v_sched_end date;
  v_today date := (now() at time zone 'Africa/Kampala')::date;
  v_pinned boolean;
  v_rows jsonb; v_tot jsonb;
begin
  if not (
    has_role(auth.uid(), 'manager') or has_role(auth.uid(), 'super_admin')
    or has_role(auth.uid(), 'ceo') or has_role(auth.uid(), 'coo')
    or has_role(auth.uid(), 'cfo') or has_role(auth.uid(), 'operations')
    or has_role(auth.uid(), 'agent_ops')
  ) then
    raise exception 'not authorized';
  end if;

  select b.period_start, b.period_end into v_start, v_end
  from public.tppo_period_bounds(p_granularity, v_anchor) b;

  v_sched_end := least(v_end, v_today);

  select exists (
    select 1 from public.agent_expected_day_plans
    where day between v_start and v_sched_end
  ) into v_pinned;

  with days as (
    select g.d::date as d from generate_series(v_start, v_sched_end, interval '1 day') g(d)
  ), pinned as (
    select p.day, p.rent_request_id, p.expected_ugx
    from public.agent_expected_day_plans p
    where p.day between v_start and v_sched_end
  ), pinned_days as (select distinct day from pinned),
  live as (
    select dy.d as day, s.rent_request_id,
           least(s.daily_amount * (dy.d - s.term_start + 1), s.total_amount)
         - least(s.daily_amount * (dy.d - s.term_start),     s.total_amount) as expected_ugx
    from days dy
    join public.v_rent_plan_schedule s
      on s.term_start <= dy.d and s.obligation_end >= dy.d
    where dy.d not in (select day from pinned_days)
  ), combined as (
    select rent_request_id, sum(expected_ugx) as scheduled_in_period
    from (select day, rent_request_id, expected_ugx from pinned
          union all
          select day, rent_request_id, expected_ugx from live) x
    group by rent_request_id
  ), detail as (
    select c.rent_request_id, c.scheduled_in_period,
           s.daily_amount, s.total_amount, s.amount_repaid,
           s.term_start, s.obligation_end, s.tenant_id, s.agent_id,
           greatest(0,
             least(s.daily_amount * greatest(least(v_sched_end - s.term_start + 1, s.oblig_days), 0), s.total_amount)
             - s.amount_repaid
           ) as arrears
    from combined c
    join public.v_rent_plan_schedule s on s.rent_request_id = c.rent_request_id
    where c.scheduled_in_period > 0
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'rent_request_id', d.rent_request_id,
      'tenant_name', coalesce(tp.full_name, 'Unnamed tenant'),
      'agent_name', coalesce(ap.full_name, 'Unassigned'),
      'daily_amount', d.daily_amount,
      'scheduled_in_period', d.scheduled_in_period,
      'arrears', d.arrears,
      'plan_total', d.total_amount,
      'repaid', d.amount_repaid,
      'term_start', to_char(d.term_start, 'YYYY-MM-DD'),
      'obligation_end', to_char(d.obligation_end, 'YYYY-MM-DD')
    ) order by d.scheduled_in_period desc, d.daily_amount desc), '[]'::jsonb)
  into v_rows
  from detail d
  left join profiles tp on tp.id = d.tenant_id
  left join profiles ap on ap.id = d.agent_id;

  select jsonb_build_object(
    'plans', coalesce(jsonb_array_length(v_rows), 0),
    'scheduled_total', coalesce((select sum((r->>'scheduled_in_period')::numeric) from jsonb_array_elements(v_rows) r), 0),
    'arrears_total', coalesce((select sum((r->>'arrears')::numeric) from jsonb_array_elements(v_rows) r), 0),
    'plans_in_arrears', coalesce((select count(*) from jsonb_array_elements(v_rows) r where (r->>'arrears')::numeric > 0), 0)
  ) into v_tot;

  return jsonb_build_object(
    'granularity', p_granularity,
    'period_start', to_char(v_start, 'YYYY-MM-DD'),
    'period_end', to_char(v_end, 'YYYY-MM-DD'),
    'scheduled_through', to_char(v_sched_end, 'YYYY-MM-DD'),
    'period_open', (v_end > v_today),
    'schedule_basis', case when v_pinned then 'pinned' else 'live' end,
    'timezone', 'Africa/Kampala',
    'totals', v_tot,
    'rows', v_rows,
    'generated_at', now()
  );
end;
$function$;

comment on function public.tppo_period_plan_detail(text, date) is
  'Plan-by-plan detail behind a TPPO period scheduled figure. Uses pinned day figures where a day is pinned so the total always reconciles with the report headline. scheduled_through shows how far into an open period the figure runs.';