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

  -- A period must not be finalised before it closes: a caller asking to finalise
  -- a still-open period legitimately gets a provisional row instead.
  v_finalise := coalesce(p_finalise, false) and v_end < v_today_kampala;

  -- Cash is only ever receipted up to today, so an open period's scheduled
  -- denominator must stop at today too.
  v_sched_end := least(v_end, v_today_kampala);

  -- A frozen denominator is frozen: never overwrite a final row.
  select s.id, s.provisional
    into v_existing_id, v_existing_provisional
  from public.tppo_period_snapshots s
  where s.granularity = p_granularity
    and s.period_start = v_start;

  if v_existing_id is not null and v_existing_provisional is false then
    return v_existing_id;
  end if;

  -- Schedule cohort: the same population the platform treats as owing rent daily
  -- (v_agent_daily_eligibility): funded/repaying, still owing, paying, not paused.
  -- Rent is expected from the day AFTER funding, and continues while a balance
  -- remains -- a completed original term does not stop the daily obligation.
  select
    coalesce(sum(coalesce(t.daily_repayment, 0) * t.overlap_days), 0),
    count(*),
    coalesce(array_agg(t.id), '{}')
  into v_scheduled, v_plan_count, v_cohort
  from (
    select
      rr.id,
      rr.daily_repayment,
      greatest(0, (v_sched_end - greatest(v_start, f.funded_start + 1)) + 1) as overlap_days
    from public.rent_requests rr
    cross join lateral (
      select
        (coalesce(rr.funded_at, rr.disbursed_at) at time zone 'Africa/Kampala')::date as funded_start
    ) f
    where f.funded_start is not null
      and rr.status in ('funded', 'repaying')
      and coalesce(rr.agent_payment_status, 'paying') <> 'not_paying'
      and (coalesce(rr.total_repayment, 0) - coalesce(rr.amount_repaid, 0)) > 0
      and not exists (
        select 1
        from public.rent_repayment_pauses p
        where p.rent_request_id = rr.id
          and p.status = 'active'
          and p.resumed_at is null
          and (p.resume_on is null or p.resume_on >= v_start)
      )
      and f.funded_start < v_end
  ) t;

  -- Arrears cohort: funded/repaying plans outside the schedule cohort
  -- (settled, or marked not paying). Cash from these is recovery, not schedule.
  select count(*), coalesce(array_agg(a.id), '{}')
  into v_arrears_count, v_arrears
  from (
    select rr.id
    from public.rent_requests rr
    where rr.status in ('funded', 'repaying')
      and not (rr.id = any (v_cohort))
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
    'scheduled_through', v_sched_end,
    'scheduled_sources', jsonb_build_array('rent_requests'),
    'cohort_rule', 'status in (funded,repaying) and owing>0 and agent_payment_status<>not_paying and not paused; due from funded_start+1',
    'collected_sources', jsonb_build_array('agent_collections', 'repayments'),
    'excluded_sources', jsonb_build_array('field_collections', 'v_tenant_ops_tenant_base'),
    'finalised', v_finalise
  );

  insert into public.tppo_period_snapshots (
    granularity, period_start, period_end,
    scheduled_due_ugx, collected_ugx, plan_count,
    arrears_recovered_ugx, arrears_plan_count,
    collected_total_ugx, unallocated_ugx,
    provisional, frozen_at, computed_at, basis
  ) values (
    p_granularity, v_start, v_end,
    v_scheduled, v_collected, v_plan_count,
    v_arrears_cash, v_arrears_count,
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