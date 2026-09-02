CREATE OR REPLACE FUNCTION public.ops_tenant_repayment_forecast(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_today date := (now() at time zone 'Africa/Kampala')::date;
  v_start date := p_start;
  v_end date := p_end;
  v_asof date;
  v_daily jsonb;
  v_expected numeric := 0;
  v_expected_to_date numeric := 0;
  v_collected numeric := 0;
  v_overdue numeric := 0;
  v_overdue_plans integer := 0;
  v_active_plans integer := 0;
  v_starting_plans integer := 0;
  v_ending_plans integer := 0;
  v_starting_ugx numeric := 0;
  v_ending_ugx numeric := 0;
  v_remaining numeric := 0;
  v_avg_daily numeric := 0;
begin
  if v_start is null or v_end is null or v_end < v_start then
    raise exception 'ops_tenant_repayment_forecast: invalid window';
  end if;

  -- Backlog is measured up to the day before the window opens (never past today).
  v_asof := least(v_start - 1, v_today);

  -- Live cohort: funded, still-active tenancies. Identical membership rule to
  -- public.tppo_freeze_period, so newly funded plans join and ended plans drop out.
  create temporary table if not exists _tpf_plans (
    id uuid,
    daily numeric,
    total numeric,
    repaid numeric,
    term_start date,
    term_end date
  ) on commit drop;
  delete from _tpf_plans;

  insert into _tpf_plans
  select
    rr.id,
    coalesce(rr.daily_repayment, 0),
    coalesce(rr.total_repayment, 0),
    coalesce(rr.amount_repaid, 0),
    f.funded_start,
    f.funded_start + coalesce(rr.duration_days, 0) - 1
  from public.rent_requests rr
  cross join lateral (
    select (coalesce(rr.funded_at, rr.disbursed_at) at time zone 'Africa/Kampala')::date as funded_start
  ) f
  where f.funded_start is not null
    and rr.tenancy_status = 'active'
    and rr.tenancy_ended_at is null;

  -- Per-day scheduled rent across the window, plus cash already receipted on
  -- days that have passed (same sources the period snapshots use).
  with days as (
    select d::date as day from generate_series(v_start, v_end, interval '1 day') d
  ), sched as (
    select
      dy.day,
      coalesce(sum(p.daily), 0) as scheduled,
      count(p.id) as plans,
      count(p.id) filter (where p.term_start = dy.day) as starting,
      count(p.id) filter (where p.term_end = dy.day) as ending,
      coalesce(sum(p.daily) filter (where p.term_start = dy.day), 0) as starting_ugx,
      coalesce(sum(p.daily) filter (where p.term_end = dy.day), 0) as ending_ugx
    from days dy
    left join _tpf_plans p
      on p.term_start <= dy.day and p.term_end >= dy.day
    group by dy.day
  ), cash as (
    select (ac.created_at at time zone 'Africa/Kampala')::date as day, sum(ac.amount) as amount
    from public.agent_collections ac
    where (ac.created_at at time zone 'Africa/Kampala')::date between v_start and v_end
    group by 1
    union all
    select (rp.created_at at time zone 'Africa/Kampala')::date, sum(rp.amount)
    from public.repayments rp
    where (rp.created_at at time zone 'Africa/Kampala')::date between v_start and v_end
    group by 1
  ), cash_day as (
    select day, coalesce(sum(amount), 0) as collected from cash group by day
  ), rows as (
    select
      s.day,
      s.scheduled,
      s.plans,
      s.starting,
      s.ending,
      s.starting_ugx,
      s.ending_ugx,
      coalesce(c.collected, 0) as collected,
      (s.day <= v_today) as elapsed
    from sched s
    left join cash_day c on c.day = s.day
    order by s.day
  )
  select
    jsonb_agg(jsonb_build_object(
      'day', to_char(day, 'YYYY-MM-DD'),
      'scheduled_ugx', scheduled,
      'collected_ugx', case when elapsed then collected else null end,
      'plans', plans,
      'starting_plans', starting,
      'ending_plans', ending,
      'starting_ugx', starting_ugx,
      'ending_ugx', ending_ugx,
      'elapsed', elapsed
    ) order by day),
    coalesce(sum(scheduled), 0),
    coalesce(sum(scheduled) filter (where elapsed), 0),
    coalesce(sum(collected) filter (where elapsed), 0),
    coalesce(sum(starting), 0),
    coalesce(sum(ending), 0),
    coalesce(sum(starting_ugx), 0),
    coalesce(sum(ending_ugx), 0)
  into v_daily, v_expected, v_expected_to_date, v_collected,
       v_starting_plans, v_ending_plans, v_starting_ugx, v_ending_ugx
  from rows;

  -- Backlog carried into the window: what should have been paid by v_asof and was not.
  select
    coalesce(sum(o.shortfall), 0),
    count(*) filter (where o.shortfall > 0)
  into v_overdue, v_overdue_plans
  from (
    select
      greatest(
        0,
        least(
          p.total,
          p.daily * greatest(0, (least(v_asof, p.term_end) - p.term_start) + 1)
        ) - p.repaid
      ) as shortfall
    from _tpf_plans p
    where p.term_start <= v_asof
  ) o;

  select
    count(*),
    coalesce(sum(greatest(0, p.total - p.repaid)), 0),
    coalesce(avg(p.daily), 0)
  into v_active_plans, v_remaining, v_avg_daily
  from _tpf_plans p
  where p.term_end >= v_today;

  return jsonb_build_object(
    'timezone', 'Africa/Kampala',
    'today', to_char(v_today, 'YYYY-MM-DD'),
    'window_start', to_char(v_start, 'YYYY-MM-DD'),
    'window_end', to_char(v_end, 'YYYY-MM-DD'),
    'days', (v_end - v_start) + 1,
    'expected_ugx', v_expected,
    'expected_to_date_ugx', v_expected_to_date,
    'collected_ugx', v_collected,
    'shortfall_to_date_ugx', greatest(0, v_expected_to_date - v_collected),
    'collection_rate_pct', case
        when v_expected_to_date > 0 then round((v_collected / v_expected_to_date) * 100, 1)
        else null
      end,
    'overdue_ugx', v_overdue,
    'overdue_plans', v_overdue_plans,
    'overdue_as_of', to_char(v_asof, 'YYYY-MM-DD'),
    'drivers', jsonb_build_object(
      'active_plans', v_active_plans,
      'avg_daily_ugx', round(v_avg_daily, 0),
      'remaining_obligation_ugx', v_remaining,
      'starting_plans', v_starting_plans,
      'starting_daily_ugx', v_starting_ugx,
      'ending_plans', v_ending_plans,
      'ending_daily_ugx', v_ending_ugx
    ),
    'daily', coalesce(v_daily, '[]'::jsonb)
  );
end;
$function$;

REVOKE ALL ON FUNCTION public.ops_tenant_repayment_forecast(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ops_tenant_repayment_forecast(date, date) TO authenticated;