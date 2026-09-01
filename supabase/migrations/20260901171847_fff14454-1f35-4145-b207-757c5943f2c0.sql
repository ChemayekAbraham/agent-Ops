CREATE OR REPLACE FUNCTION public.tppo_freeze_period(p_granularity text, p_anchor date, p_finalise boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_start date;
  v_end date;
  v_scheduled numeric := 0;
  v_plan_count integer := 0;
  v_cohort uuid[] := '{}';
  v_collected numeric := 0;
  v_outside numeric := 0;
  v_total numeric := 0;
  v_outside_receipts integer := 0;
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

  -- Scheduled due: daily rent x days the tenancy was live inside the period.
  -- The same single pass yields the cohort of rent_request_id values for the period.
  select
    coalesce(sum(coalesce(t.daily_repayment, 0) * t.overlap_days), 0),
    count(*),
    coalesce(array_agg(t.rent_request_id) filter (where t.rent_request_id is not null), '{}')
  into v_scheduled, v_plan_count, v_cohort
  from (
    select
      v.rent_request_id,
      v.daily_repayment,
      greatest(
        0,
        (least(v_end, x.effective_end) - greatest(v_start, v.funded_date)) + 1
      ) as overlap_days
    from public.v_tenant_ops_tenant_base v
    join public.rent_requests r on r.id = v.rent_request_id
    cross join lateral (
      select case
               when r.tenancy_ended_at is not null
                 then least(v.lease_end_date, (r.tenancy_ended_at at time zone 'Africa/Kampala')::date)
               else v.lease_end_date
             end as effective_end
    ) x
    where v.funded_date is not null
      and x.effective_end is not null
      and v.funded_date <= v_end
      and x.effective_end >= v_start
  ) t;

  -- Collected: cash receipted in the period, Kampala local days on both bounds.
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
      (rc.rent_request_id is not null and rc.rent_request_id = any (v_cohort)) as in_cohort
    from receipts rc
  )
  select
    coalesce(sum(case when in_cohort then amount else 0 end), 0),
    coalesce(sum(case when in_cohort then 0 else amount end), 0),
    coalesce(sum(amount), 0),
    count(*) filter (where not in_cohort)
  into v_collected, v_outside, v_total, v_outside_receipts
  from tagged;

  v_basis := jsonb_build_object(
    'timezone', 'Africa/Kampala',
    'plan_count', v_plan_count,
    'cohort_plan_count', v_plan_count,
    'outside_cohort_receipt_count', v_outside_receipts,
    'granularity', p_granularity,
    'period_start', v_start,
    'period_end', v_end,
    'scheduled_sources', jsonb_build_array('v_tenant_ops_tenant_base', 'rent_requests'),
    'collected_sources', jsonb_build_array('agent_collections', 'repayments'),
    'excluded_sources', jsonb_build_array('field_collections'),
    'finalised', p_finalise
  );

  insert into public.tppo_period_snapshots (
    granularity, period_start, period_end,
    scheduled_due_ugx, collected_ugx, plan_count,
    collected_outside_cohort_ugx, collected_total_ugx,
    provisional, frozen_at, computed_at, basis
  ) values (
    p_granularity, v_start, v_end,
    v_scheduled, v_collected, v_plan_count,
    v_outside, v_total,
    not p_finalise,
    case when p_finalise then now() else null end,
    now(), v_basis
  )
  on conflict (granularity, period_start) do update
    set period_end        = excluded.period_end,
        scheduled_due_ugx = excluded.scheduled_due_ugx,
        collected_ugx     = excluded.collected_ugx,
        plan_count        = excluded.plan_count,
        collected_outside_cohort_ugx = excluded.collected_outside_cohort_ugx,
        collected_total_ugx = excluded.collected_total_ugx,
        provisional       = excluded.provisional,
        frozen_at         = excluded.frozen_at,
        computed_at       = excluded.computed_at,
        basis             = excluded.basis
  returning id into v_id;

  return v_id;
end;
$function$;