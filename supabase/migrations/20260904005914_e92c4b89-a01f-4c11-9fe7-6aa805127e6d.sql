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

  if v_live_day then
    -- The day still in progress uses the platform's live daily expectation
    -- (the eligible_rents rule behind v_agent_daily_eligibility) so the open-day
    -- figure equals what is actually expected to be collected today.
    with day_start as (
      select ((now() at time zone 'Africa/Kampala')::date::timestamp without time zone at time zone 'Africa/Kampala') as ts
    ), active_rents as (
      select rr.id as rent_request_id, rr.daily_repayment, rr.amount_repaid, rr.total_repayment, rr.funded_at
      from public.rent_requests rr
      where rr.status = any (array['funded','repaying'])
        and coalesce(rr.agent_payment_status, 'paying') <> 'not_paying'
    ), prior_paid as (
      select ac.rent_request_id, sum(ac.amount) as paid_before_today
      from public.agent_collections ac cross join day_start ds
      where ac.rent_request_id is not null and ac.created_at < ds.ts
      group by ac.rent_request_id
    ), paused as (
      select distinct p.rent_request_id
      from public.rent_repayment_pauses p
      where p.status = 'active' and p.resumed_at is null
        and (p.resume_on is null or p.resume_on >= (now() at time zone 'Africa/Kampala')::date)
    ), reversed as (
      select distinct r.rent_request_id from public.agent_tenant_float_reversals r
    ), landlord_settled as (
      select distinct a.rent_request_id
      from public.agent_landlord_float_allocations a
      where a.rent_request_id is not null and a.paid_out_amount > 0
    ), alloc_activity as (
      select a.rent_request_id, max(greatest(a.created_at, coalesce(a.updated_at, a.created_at))) as last_change
      from public.agent_landlord_float_allocations a
      where a.rent_request_id is not null
      group by a.rent_request_id
    ), eligible_rents as (
      select ar.rent_request_id, coalesce(ar.daily_repayment, 0) as daily_repayment
      from active_rents ar
        cross join day_start ds
        left join prior_paid pp on pp.rent_request_id = ar.rent_request_id
        left join alloc_activity aa on aa.rent_request_id = ar.rent_request_id
        left join reversed rv on rv.rent_request_id = ar.rent_request_id
        left join paused pz on pz.rent_request_id = ar.rent_request_id
        left join landlord_settled ls on ls.rent_request_id = ar.rent_request_id
        left join lateral (
          select count(*) as open_allocs
          from public.agent_landlord_float_allocations oa_1
          where oa_1.rent_request_id = ar.rent_request_id
            and oa_1.status = any (array['open','partially_paid','return_pending'])
        ) oa on true
      where (rv.rent_request_id is null or coalesce(pp.paid_before_today, 0) > 0)
        and pz.rent_request_id is null
        and (coalesce(ar.total_repayment, 0) - coalesce(ar.amount_repaid, 0)) > 0
        and (
          coalesce(pp.paid_before_today, 0) > 0
          or (
            (ar.funded_at is null or ar.funded_at < ds.ts)
            and (aa.last_change is null or aa.last_change < ds.ts)
            and (ls.rent_request_id is not null or coalesce(oa.open_allocs, 0) = 0)
          )
        )
    )
    select
      coalesce(sum(er.daily_repayment), 0),
      count(*),
      coalesce(array_agg(er.rent_request_id), '{}')
    into v_scheduled, v_plan_count, v_cohort
    from eligible_rents er;
  else
    -- Schedule cohort: the same population the platform treats as owing rent daily
    -- (v_agent_daily_eligibility): funded/repaying, still owing, paying, not paused.
    -- Rent is expected from the day AFTER funding and continues while a balance remains.
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
  end if;

  -- Arrears plans: funded/repaying plans outside the schedule cohort
  -- (settled, or marked not paying). They accrue no scheduled rent.
  select count(*)
  into v_arrears_count
  from public.rent_requests rr
  where rr.status in ('funded', 'repaying')
    and not (rr.id = any (v_cohort));

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
    'cohort_rule', case
      when v_live_day then 'live day: v_agent_daily_eligibility eligible_rents rule (real-time expected today)'
      else 'status in (funded,repaying) and owing>0 and agent_payment_status<>not_paying and not paused; due from funded_start+1'
    end,
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