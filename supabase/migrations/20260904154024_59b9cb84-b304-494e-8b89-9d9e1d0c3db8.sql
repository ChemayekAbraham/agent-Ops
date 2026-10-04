CREATE OR REPLACE FUNCTION public.tppo_freeze_period(p_granularity text, p_anchor date, p_finalise boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_start date;
  v_end date;
  v_sched_end date;
  v_today_kampala date := (now() at time zone 'Africa/Kampala')::date;
  v_finalise boolean;
  v_scheduled numeric := 0;
  v_plan_count integer := 0;
  v_arrears_count integer := 0;
  v_arrears_target numeric := 0;
  v_arrears_target_plans integer := 0;
  v_arrears_outstanding numeric := 0;
  v_cohort uuid[] := '{}';
  v_collected numeric := 0;
  v_arrears_cash numeric := 0;
  v_total numeric := 0;
  v_unallocated numeric := 0;
  v_unallocated_receipts integer := 0;
  v_existing_id uuid;
  v_existing_provisional boolean;
  v_id uuid;
  v_basis jsonb;
  v_live_day boolean := false;
begin
  if p_granularity not in ('day', 'week', 'month') then
    raise exception 'tppo_freeze_period: unsupported granularity %', p_granularity;
  end if;

  select b.period_start, b.period_end
    into v_start, v_end
  from public.tppo_period_bounds(p_granularity, p_anchor) b;

  v_finalise := coalesce(p_finalise, false) and v_end < v_today_kampala;
  v_sched_end := least(v_end, v_today_kampala);

  select s.id, s.provisional
    into v_existing_id, v_existing_provisional
  from public.tppo_period_snapshots s
  where s.granularity = p_granularity
    and s.period_start = v_start;

  if v_existing_id is not null and v_existing_provisional is false then
    return v_existing_id;
  end if;

  v_live_day := (p_granularity = 'day' and v_start = v_today_kampala);

  with days as (
    select g.d::date as d
    from generate_series(v_start, v_sched_end, interval '1 day') g(d)
  ), pinned as (
    select p.day, p.rent_request_id, p.expected_ugx
    from public.agent_expected_day_plans p
    where p.day between v_start and v_sched_end
  ), pinned_days as (
    select distinct day from pinned
  ), live as (
    select dy.d as day, s.rent_request_id,
           least(s.daily_amount * (dy.d - s.term_start + 1), s.total_amount)
         - least(s.daily_amount * (dy.d - s.term_start),     s.total_amount) as expected_ugx
    from days dy
    join public.v_rent_plan_schedule s
      on s.term_start <= dy.d and s.obligation_end >= dy.d
    where dy.d not in (select day from pinned_days)
  ), combined as (
    select day, rent_request_id, expected_ugx from pinned
    union all
    select day, rent_request_id, expected_ugx from live
  )
  select coalesce(sum(expected_ugx), 0),
         count(distinct rent_request_id),
         coalesce(array_agg(distinct rent_request_id), '{}')
  into v_scheduled, v_plan_count, v_cohort
  from combined;

  -- Arrears plans: funded/repaying plans outside the schedule cohort
  -- (settled, or marked not paying). They accrue no scheduled rent.
  select count(*)
  into v_arrears_count
  from public.rent_requests rr
  where rr.status in ('funded', 'repaying')
    and not (rr.id = any (v_cohort));

  -- Arrears collection target: plans still owed, on days of this period where
  -- they carry no scheduled instalment. Disjoint from scheduled_due_ugx.
  -- v_sched_end is already the earlier of period_end and today (Africa/Kampala).
  with sched as (
    select s.rent_request_id, s.daily_amount, s.total_amount, s.amount_repaid,
           s.term_start, s.obligation_end, s.oblig_days,
           greatest(0,
             least(s.daily_amount * greatest(least(v_sched_end - s.term_start + 1, s.oblig_days), 0), s.total_amount)
             - s.amount_repaid
           ) as arrears
    from public.v_rent_plan_schedule s
  ), owing as (
    select * from sched where arrears > 0
  ), unscheduled_days as (
    select o.rent_request_id, o.daily_amount, o.arrears,
           count(*) filter (
             where not (o.term_start <= d.d and o.obligation_end >= d.d)
           ) as days_without_instalment
    from owing o
    cross join generate_series(v_start, v_sched_end, interval '1 day') d(d)
    group by o.rent_request_id, o.daily_amount, o.arrears
  )
  select coalesce(sum(daily_amount * days_without_instalment), 0),
         count(*) filter (where days_without_instalment > 0),
         coalesce((select sum(arrears) from owing), 0)
  into v_arrears_target, v_arrears_target_plans, v_arrears_outstanding
  from unscheduled_days;

  -- Cash receipted in the period, Kampala local days on both bounds.
  -- field_collections is deliberately excluded (confirmed_collection_id would double-count).
  with receipts as (
    select ac.rent_request_id, ac.amount
    from public.agent_collections ac
    where (ac.created_at at time zone 'Africa/Kampala')::date between v_start and v_end
    union all
    select rp.rent_request_id, rp.amount
    from public.repayments rp
    where (rp.created_at at time zone 'Africa/Kampala')::date between v_start and v_end
  ), tagged as (
    select
      rc.amount,
      (rc.rent_request_id is not null and rc.rent_request_id = any (v_cohort)) as in_cohort,
      (rc.rent_request_id is not null and not (rc.rent_request_id = any (v_cohort))) as in_arrears
    from receipts rc
  )
  select
    coalesce(sum(case when in_cohort then amount else 0 end), 0),
    coalesce(sum(case when in_arrears and not in_cohort then amount else 0 end), 0),
    coalesce(sum(amount), 0),
    count(*) filter (where not in_cohort and not in_arrears)
  into v_collected, v_arrears_cash, v_total, v_unallocated_receipts
  from tagged;

  v_unallocated := v_total - v_collected - v_arrears_cash;

  v_basis := jsonb_build_object(
    'timezone', 'Africa/Kampala',
    'plan_count', v_plan_count,
    'cohort_plan_count', v_plan_count,
    'arrears_plan_count', v_arrears_count,
    'unallocated_receipt_count', v_unallocated_receipts,
    'granularity', p_granularity,
    'period_start', v_start,
    'period_end', v_end,
    'scheduled_through', v_sched_end,
    'scheduled_sources', jsonb_build_array('rent_requests'),
    'cohort_rule', 'v_rent_plan_schedule within obligation window; pinned days read from agent_expected_day_plans',
    'basis_version', 2,
    'pinned_days', (select count(*) from public.agent_expected_day_plans p where p.day between v_start and v_sched_end and p.day is not null),
    'collected_sources', jsonb_build_array('agent_collections', 'repayments'),
    'excluded_sources', jsonb_build_array('field_collections', 'v_tenant_ops_tenant_base'),
    'finalised', v_finalise
  );

  insert into public.tppo_period_snapshots (
    granularity, period_start, period_end,
    scheduled_due_ugx, collected_ugx, plan_count,
    arrears_recovered_ugx, arrears_plan_count,
    arrears_target_ugx, arrears_target_plan_count, arrears_outstanding_ugx,
    collected_total_ugx, unallocated_ugx,
    provisional, frozen_at, computed_at, basis
  ) values (
    p_granularity, v_start, v_end,
    v_scheduled, v_collected, v_plan_count,
    v_arrears_cash, v_arrears_count,
    v_arrears_target, v_arrears_target_plans, v_arrears_outstanding,
    v_total, v_unallocated,
    not v_finalise,
    case when v_finalise then now() else null end,
    now(), v_basis
  )
  on conflict (granularity, period_start) do update
    set period_end        = excluded.period_end,
        scheduled_due_ugx = excluded.scheduled_due_ugx,
        collected_ugx     = excluded.collected_ugx,
        plan_count        = excluded.plan_count,
        arrears_recovered_ugx = excluded.arrears_recovered_ugx,
        arrears_plan_count    = excluded.arrears_plan_count,
        arrears_target_ugx    = excluded.arrears_target_ugx,
        arrears_target_plan_count = excluded.arrears_target_plan_count,
        arrears_outstanding_ugx   = excluded.arrears_outstanding_ugx,
        collected_total_ugx = excluded.collected_total_ugx,
        unallocated_ugx     = excluded.unallocated_ugx,
        provisional       = excluded.provisional,
        frozen_at         = excluded.frozen_at,
        computed_at       = excluded.computed_at,
        basis             = excluded.basis
  returning id into v_id;

  return v_id;
end;
$function$;