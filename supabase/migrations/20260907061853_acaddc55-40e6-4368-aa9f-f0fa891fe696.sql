CREATE OR REPLACE FUNCTION public.tppo_period_plan_detail(p_granularity text, p_anchor date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_anchor date := coalesce(p_anchor, (now() at time zone 'Africa/Kampala')::date);
  v_start date; v_end date; v_sched_end date;
  v_today date := (now() at time zone 'Africa/Kampala')::date;
  v_pinned boolean;
  v_rows jsonb; v_tot jsonb;
  v_outside numeric := 0;
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

  with pinned as (
    select p.day, p.rent_request_id, p.expected_ugx
    from public.agent_expected_day_plans p
    where p.day between v_start and v_sched_end
  ), pinned_days as (
    select distinct day from pinned
  ), live as (
    select g.due_on as day, g.rent_request_id, g.amount as expected_ugx
    from public.rent_plan_schedule_days(v_start, v_sched_end) g
    where g.due_on not in (select day from pinned_days)
  ), combined as (
    select rent_request_id, sum(expected_ugx) as scheduled_in_period
    from (select day, rent_request_id, expected_ugx from pinned
          union all
          select day, rent_request_id, expected_ugx from live) x
    group by rent_request_id
  ), paid_period as (
    select x.rent_request_id, sum(x.amount) as paid_in_period
    from (
      select ac.rent_request_id, ac.amount, ac.created_at
      from public.agent_collections ac
      where ac.rent_request_id is not null
      union all
      select rp.rent_request_id, rp.amount, rp.created_at
      from public.repayments rp
      where rp.rent_request_id is not null
        and not exists (
          select 1 from public.agent_collections a
          where a.rent_request_id = rp.rent_request_id
            and a.amount = rp.amount
            and abs(extract(epoch from (a.created_at - rp.created_at))) < 300
        )
    ) x
    where (x.created_at at time zone 'Africa/Kampala')::date between v_start and v_sched_end
    group by x.rent_request_id
  ), detail as (
    select c.rent_request_id, c.scheduled_in_period,
           s.daily_amount, s.total_amount, s.amount_repaid,
           s.term_start, s.obligation_end, s.tenant_id, s.agent_id,
           greatest(0,
             least(s.daily_amount * greatest(least(v_sched_end - s.term_start + 1, s.oblig_days), 0), s.total_amount)
             - s.amount_repaid
           ) as arrears,
           coalesce(pp.paid_in_period, 0) as paid_in_period,
           greatest(0, c.scheduled_in_period - coalesce(pp.paid_in_period, 0)) as scheduled_outstanding,
           greatest(0, coalesce(pp.paid_in_period, 0) - c.scheduled_in_period) as overpaid_in_period
    from combined c
    join public.v_rent_plan_schedule s on s.rent_request_id = c.rent_request_id
    left join paid_period pp on pp.rent_request_id = c.rent_request_id
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
      'obligation_end', to_char(d.obligation_end, 'YYYY-MM-DD'),
      'paid_in_period', d.paid_in_period,
      'scheduled_outstanding', d.scheduled_outstanding,
      'overpaid_in_period', d.overpaid_in_period
    ) order by d.scheduled_in_period desc, d.daily_amount desc), '[]'::jsonb)
  into v_rows
  from detail d
  left join profiles tp on tp.id = d.tenant_id
  left join profiles ap on ap.id = d.agent_id;

  with pinned as (
    select p.day, p.rent_request_id, p.expected_ugx
    from public.agent_expected_day_plans p
    where p.day between v_start and v_sched_end
  ), pinned_days as (
    select distinct day from pinned
  ), live as (
    select g.due_on as day, g.rent_request_id, g.amount as expected_ugx
    from public.rent_plan_schedule_days(v_start, v_sched_end) g
    where g.due_on not in (select day from pinned_days)
  ), combined as (
    select rent_request_id, sum(expected_ugx) as scheduled_in_period
    from (select day, rent_request_id, expected_ugx from pinned
          union all
          select day, rent_request_id, expected_ugx from live) x
    group by rent_request_id
  ), paid_period as (
    select x.rent_request_id, sum(x.amount) as paid_in_period
    from (
      select ac.rent_request_id, ac.amount, ac.created_at
      from public.agent_collections ac
      where ac.rent_request_id is not null
      union all
      select rp.rent_request_id, rp.amount, rp.created_at
      from public.repayments rp
      where rp.rent_request_id is not null
        and not exists (
          select 1 from public.agent_collections a
          where a.rent_request_id = rp.rent_request_id
            and a.amount = rp.amount
            and abs(extract(epoch from (a.created_at - rp.created_at))) < 300
        )
    ) x
    where (x.created_at at time zone 'Africa/Kampala')::date between v_start and v_sched_end
    group by x.rent_request_id
  )
  select coalesce(sum(pp.paid_in_period), 0)
  into v_outside
  from paid_period pp
  where not exists (
    select 1 from combined c
    where c.rent_request_id = pp.rent_request_id and c.scheduled_in_period > 0
  );

  select jsonb_build_object(
    'plans', coalesce(jsonb_array_length(v_rows), 0),
    'scheduled_total', coalesce((select sum((r->>'scheduled_in_period')::numeric) from jsonb_array_elements(v_rows) r), 0),
    'arrears_total', coalesce((select sum((r->>'arrears')::numeric) from jsonb_array_elements(v_rows) r), 0),
    'plans_in_arrears', coalesce((select count(*) from jsonb_array_elements(v_rows) r where (r->>'arrears')::numeric > 0), 0),
    'paid_total', coalesce((select sum((r->>'paid_in_period')::numeric) from jsonb_array_elements(v_rows) r), 0),
    'outstanding_total', coalesce((select sum((r->>'scheduled_outstanding')::numeric) from jsonb_array_elements(v_rows) r), 0),
    'overpaid_total', coalesce((select sum((r->>'overpaid_in_period')::numeric) from jsonb_array_elements(v_rows) r), 0),
    'plans_paid', coalesce((select count(*) from jsonb_array_elements(v_rows) r where (r->>'paid_in_period')::numeric > 0), 0)
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
    'paid_outside_schedule', v_outside,
    'generated_at', now()
  );
end;
$function$;