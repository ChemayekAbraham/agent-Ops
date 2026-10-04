create or replace function public.ops_tenant_repayment_forecast(p_start date, p_end date)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
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

  v_asof := least(v_start - 1, v_today);

  with plans as (
    select s.rent_request_id as id, s.daily_amount as daily, s.total_amount as total,
           s.amount_repaid as repaid, s.term_start, s.obligation_end as term_end
    from public.v_rent_plan_schedule s
  ), days as (
    select d::date as day from generate_series(v_start, v_end, interval '1 day') d
  ), sched as (
    select dy.day,
      coalesce(sum(least(p.daily * (dy.day - p.term_start + 1), p.total)
                 - least(p.daily * (dy.day - p.term_start),     p.total)), 0) as scheduled,
      count(p.id) as plans,
      count(p.id) filter (where p.term_start = dy.day) as starting,
      count(p.id) filter (where p.term_end   = dy.day) as ending,
      coalesce(sum(p.daily) filter (where p.term_start = dy.day), 0) as starting_ugx,
      coalesce(sum(p.daily) filter (where p.term_end   = dy.day), 0) as ending_ugx
    from days dy
    left join plans p on p.term_start <= dy.day and p.term_end >= dy.day
    group by dy.day
  ), cash as (
    select (ac.created_at at time zone 'Africa/Kampala')::date as day, ac.amount as amount
    from public.agent_collections ac
    where (ac.created_at at time zone 'Africa/Kampala')::date between v_start and v_end
    union all
    select (rp.created_at at time zone 'Africa/Kampala')::date, rp.amount
    from public.repayments rp
    where (rp.created_at at time zone 'Africa/Kampala')::date between v_start and v_end
      and not exists (
        select 1 from public.agent_collections a
        where a.rent_request_id = rp.rent_request_id
          and a.amount = rp.amount
          and abs(extract(epoch from (a.created_at - rp.created_at))) < 300
      )
  ), cash_day as (
    select day, coalesce(sum(amount), 0) as collected from cash group by day
  ), rws as (
    select s.day, s.scheduled, s.plans, s.starting, s.ending, s.starting_ugx, s.ending_ugx,
           coalesce(c.collected, 0) as collected, (s.day <= v_today) as elapsed
    from sched s left join cash_day c on c.day = s.day
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
  from rws;

  with owed as (
    select greatest(0,
      least(s.daily_amount * greatest(least(v_asof - s.term_start + 1, s.oblig_days), 0), s.total_amount)
      - s.amount_repaid
    ) as shortfall
    from public.v_rent_plan_schedule s
    where s.term_start <= v_asof
  )
  select coalesce(sum(shortfall), 0), count(*) filter (where shortfall > 0)
  into v_overdue, v_overdue_plans
  from owed;

  select count(*), coalesce(sum(greatest(0, s.total_amount - s.amount_repaid)), 0), coalesce(avg(s.daily_amount), 0)
  into v_active_plans, v_remaining, v_avg_daily
  from public.v_rent_plan_schedule s
  where s.obligation_end >= v_today;

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