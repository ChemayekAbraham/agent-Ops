alter table public.tppo_period_snapshots
  add column if not exists arrears_recovered_ugx numeric(14,2) not null default 0,
  add column if not exists collected_total_ugx   numeric(14,2) not null default 0,
  add column if not exists unallocated_ugx       numeric(14,2) not null default 0,
  add column if not exists arrears_plan_count    integer       not null default 0;

create or replace function public.tppo_freeze_period(p_granularity text, p_anchor date, p_finalise boolean default false)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_start date;
  v_end date;
  v_scheduled numeric := 0;
  v_plan_count integer := 0;
  v_arrears_count integer := 0;
  v_cohort uuid[] := '{}';
  v_arrears uuid[] := '{}';
  v_collected numeric := 0;
  v_arrears_cash numeric := 0;
  v_total numeric := 0;
  v_unallocated numeric := 0;
  v_unallocated_receipts integer := 0;
  v_existing_id uuid;
  v_existing_provisional boolean;
  v_id uuid;
  v_basis jsonb;
begin
  if p_granularity not in ('day', 'week', 'month') then
    raise exception 'tppo_freeze_period: unsupported granularity %', p_granularity;
  end if;

  select b.period_start, b.period_end
    into v_start, v_end
  from public.tppo_period_bounds(p_granularity, p_anchor) b;

  -- A frozen denominator is frozen: never overwrite a final row.
  select s.id, s.provisional
    into v_existing_id, v_existing_provisional
  from public.tppo_period_snapshots s
  where s.granularity = p_granularity
    and s.period_start = v_start;

  if v_existing_id is not null and v_existing_provisional is false then
    return v_existing_id;
  end if;

  -- Schedule cohort: funded, still-active tenancies whose term overlaps the period.
  select
    coalesce(sum(coalesce(t.daily_repayment, 0) * t.overlap_days), 0),
    count(*),
    coalesce(array_agg(t.id), '{}')
  into v_scheduled, v_plan_count, v_cohort
  from (
    select
      rr.id,
      rr.daily_repayment,
      greatest(
        0,
        (least(v_end, b.term_end) - greatest(v_start, b.funded_start)) + 1
      ) as overlap_days
    from public.rent_requests rr
    cross join lateral (
      select
        (coalesce(rr.funded_at, rr.disbursed_at) at time zone 'Africa/Kampala')::date as funded_start
    ) f
    cross join lateral (
      select f.funded_start, f.funded_start + coalesce(rr.duration_days, 0) - 1 as term_end
    ) b
    where f.funded_start is not null
      and rr.tenancy_status = 'active'
      and rr.tenancy_ended_at is null
      and b.funded_start <= v_end
      and b.term_end >= v_start
  ) t;

  -- Arrears cohort: funded, still-active tenancies whose term completed before the period.
  -- These accrue no scheduled rent.
  select count(*), coalesce(array_agg(a.id), '{}')
  into v_arrears_count, v_arrears
  from (
    select rr.id
    from public.rent_requests rr
    cross join lateral (
      select
        (coalesce(rr.funded_at, rr.disbursed_at) at time zone 'Africa/Kampala')::date as funded_start
    ) f
    where f.funded_start is not null
      and rr.tenancy_status = 'active'
      and rr.tenancy_ended_at is null
      and (f.funded_start + coalesce(rr.duration_days, 0) - 1) < v_start
  ) a;

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
      (rc.rent_request_id is not null and rc.rent_request_id = any (v_arrears)) as in_arrears
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
    'scheduled_sources', jsonb_build_array('rent_requests'),
    'collected_sources', jsonb_build_array('agent_collections', 'repayments'),
    'excluded_sources', jsonb_build_array('field_collections', 'v_tenant_ops_tenant_base'),
    'finalised', p_finalise
  );

  insert into public.tppo_period_snapshots (
    granularity, period_start, period_end,
    scheduled_due_ugx, collected_ugx, plan_count,
    arrears_recovered_ugx, arrears_plan_count,
    collected_outside_cohort_ugx, collected_total_ugx, unallocated_ugx,
    provisional, frozen_at, computed_at, basis
  ) values (
    p_granularity, v_start, v_end,
    v_scheduled, v_collected, v_plan_count,
    v_arrears_cash, v_arrears_count,
    v_total - v_collected, v_total, v_unallocated,
    not p_finalise,
    case when p_finalise then now() else null end,
    now(), v_basis
  )
  on conflict (granularity, period_start) do update
    set period_end        = excluded.period_end,
        scheduled_due_ugx = excluded.scheduled_due_ugx,
        collected_ugx     = excluded.collected_ugx,
        plan_count        = excluded.plan_count,
        arrears_recovered_ugx = excluded.arrears_recovered_ugx,
        arrears_plan_count    = excluded.arrears_plan_count,
        collected_outside_cohort_ugx = excluded.collected_outside_cohort_ugx,
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

create or replace function public.tppo_get_report_zone_a(p_granularity text, p_anchor date)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_start date;
  v_end date;
  v_prior_anchor date;
  v_prior_start date;
  v_prior_end date;
  v_cur record;
  v_prior record;
  v_rate numeric;
  v_prior_rate numeric;
  v_threshold numeric;
  v_report record;
begin
  select b.period_start, b.period_end into v_start, v_end
  from public.tppo_period_bounds(p_granularity, p_anchor) b;

  v_prior_anchor := v_start - 1;

  select b.period_start, b.period_end into v_prior_start, v_prior_end
  from public.tppo_period_bounds(p_granularity, v_prior_anchor) b;

  perform public.tppo_freeze_period(p_granularity, p_anchor, false);
  perform public.tppo_freeze_period(p_granularity, v_prior_anchor, true);

  select * into v_cur
  from public.tppo_period_snapshots
  where granularity = p_granularity and period_start = v_start;

  select * into v_prior
  from public.tppo_period_snapshots
  where granularity = p_granularity and period_start = v_prior_start;

  select * into v_report
  from public.tppo_reports
  where granularity = p_granularity and period_start = v_start
  order by created_at desc
  limit 1;

  v_threshold := coalesce(v_report.threshold_pct, 70.0);

  if v_cur.scheduled_due_ugx is not null and v_cur.scheduled_due_ugx <> 0 then
    v_rate := round((v_cur.collected_ugx / v_cur.scheduled_due_ugx) * 100, 1);
  end if;

  if v_prior.scheduled_due_ugx is not null and v_prior.scheduled_due_ugx <> 0 then
    v_prior_rate := round((v_prior.collected_ugx / v_prior.scheduled_due_ugx) * 100, 1);
  end if;

  return jsonb_build_object(
    'granularity', p_granularity,
    'period_start', v_start,
    'period_end', v_end,
    'collected_ugx', v_cur.collected_ugx,
    'arrears_recovered_ugx', v_cur.arrears_recovered_ugx,
    'collected_outside_cohort_ugx', v_cur.collected_outside_cohort_ugx,
    'collected_total_ugx', v_cur.collected_total_ugx,
    'unallocated_ugx', v_cur.unallocated_ugx,
    'cohort_plan_count', v_cur.plan_count,
    'arrears_plan_count', v_cur.arrears_plan_count,
    'scheduled_due_ugx', v_cur.scheduled_due_ugx,
    'provisional', v_cur.provisional,
    'collection_rate_pct', v_rate,
    'threshold_pct', v_threshold,
    'below_threshold', case when v_rate is null then null else v_rate < v_threshold end,
    'prior', jsonb_build_object(
      'period_start', v_prior_start,
      'period_end', v_prior_end,
      'collected_ugx', v_prior.collected_ugx,
      'arrears_recovered_ugx', v_prior.arrears_recovered_ugx,
      'collected_outside_cohort_ugx', v_prior.collected_outside_cohort_ugx,
      'collected_total_ugx', v_prior.collected_total_ugx,
      'unallocated_ugx', v_prior.unallocated_ugx,
      'cohort_plan_count', v_prior.plan_count,
      'arrears_plan_count', v_prior.arrears_plan_count,
      'scheduled_due_ugx', v_prior.scheduled_due_ugx,
      'collection_rate_pct', v_prior_rate
    ),
    'rate_variance_pp', case
        when v_rate is null or v_prior_rate is null then null
        else round(v_rate - v_prior_rate, 1)
      end,
    'collected_delta_ugx', case
        when v_cur.collected_ugx is null or v_prior.collected_ugx is null then null
        else v_cur.collected_ugx - v_prior.collected_ugx
      end,
    'scheduled_delta_ugx', case
        when v_cur.scheduled_due_ugx is null or v_prior.scheduled_due_ugx is null then null
        else v_cur.scheduled_due_ugx - v_prior.scheduled_due_ugx
      end,
    'report_id', v_report.id,
    'status', v_report.status
  );
end;
$function$;