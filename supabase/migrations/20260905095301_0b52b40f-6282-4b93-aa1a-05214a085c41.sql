CREATE OR REPLACE FUNCTION public.pin_agent_expected_day(p_day date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_rows int := 0;
begin
  if p_day is null or p_day > (now() at time zone 'Africa/Kampala')::date then
    return 0;
  end if;

  if exists (select 1 from public.agent_expected_day_plans where day = p_day) then
    return 0;
  end if;

  insert into public.agent_expected_day_plans (day, rent_request_id, agent_id, tenant_id, expected_ugx)
  select p_day, g.rent_request_id, s.agent_id, s.tenant_id, g.amount
  from public.rent_plan_schedule_days(p_day, p_day) g
  join public.v_rent_plan_schedule s on s.rent_request_id = g.rent_request_id
  on conflict (day, rent_request_id) do nothing;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$function$;

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
  v_open_asof date;
  v_asof date;
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
  v_asof := v_sched_end;

  select s.id, s.provisional
    into v_existing_id, v_existing_provisional
  from public.tppo_period_snapshots s
  where s.granularity = p_granularity
    and s.period_start = v_start;

  if v_existing_id is not null and v_existing_provisional is false then
    return v_existing_id;
  end if;

  v_live_day := (p_granularity = 'day' and v_start = v_today_kampala);

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

  -- Arrears target: arrears outstanding at the start of the period (opening stock).
  v_open_asof := v_start - 1;

  with sched as (
    select s.rent_request_id, s.daily_amount, s.total_amount, s.amount_repaid,
           s.term_start, s.obligation_end, s.oblig_days,
           coalesce((select sum(ac.amount) from public.agent_collections ac
              where ac.rent_request_id = s.rent_request_id
                and (ac.created_at at time zone 'Africa/Kampala')::date > v_open_asof), 0) as paid_after
    from public.v_rent_plan_schedule s
  ), opening as (
    select rent_request_id,
      greatest(0,
        least(daily_amount * greatest(least(v_open_asof - term_start + 1, oblig_days), 0), total_amount)
        - greatest(0, amount_repaid - paid_after)
      ) as opening_arrears
    from sched
  )
  select coalesce(sum(opening_arrears), 0), count(*) filter (where opening_arrears > 0)
  into v_arrears_target, v_arrears_target_plans
  from opening;

  select coalesce(sum(greatest(0,
      least(s.daily_amount * greatest(least(v_asof - s.term_start + 1, s.oblig_days), 0), s.total_amount)
      - greatest(0, s.amount_repaid - coalesce((
          select sum(ac.amount) from public.agent_collections ac
          where ac.rent_request_id = s.rent_request_id
            and (ac.created_at at time zone 'Africa/Kampala')::date > v_asof), 0))
    )), 0)
  into v_arrears_outstanding
  from public.v_rent_plan_schedule s;

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
    'cohort_rule', 'rent_plan_schedule_days honouring repayment_frequency; pinned days read from agent_expected_day_plans',
    'basis_version', 3,
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