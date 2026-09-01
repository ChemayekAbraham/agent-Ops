create or replace function public.tppo_period_bounds(
  p_granularity text,
  p_anchor date
)
returns table (period_start date, period_end date)
language sql
immutable
security definer
set search_path = public
as $$
  select
    case p_granularity
      when 'day'   then p_anchor
      when 'week'  then (date_trunc('week', p_anchor::timestamp))::date
      when 'month' then (date_trunc('month', p_anchor::timestamp))::date
    end as period_start,
    case p_granularity
      when 'day'   then p_anchor
      when 'week'  then ((date_trunc('week', p_anchor::timestamp) + interval '6 days'))::date
      when 'month' then ((date_trunc('month', p_anchor::timestamp) + interval '1 month - 1 day'))::date
    end as period_end
$$;

create or replace function public.tppo_freeze_period(
  p_granularity text,
  p_anchor date,
  p_finalise boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start date;
  v_end date;
  v_scheduled numeric := 0;
  v_plan_count integer := 0;
  v_collected numeric := 0;
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
  select
    coalesce(sum(coalesce(t.daily_repayment, 0) * t.overlap_days), 0),
    count(*)
  into v_scheduled, v_plan_count
  from (
    select
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
  select coalesce(sum(ac.amount), 0)
    into v_collected
  from public.agent_collections ac
  where (ac.created_at at time zone 'Africa/Kampala')::date between v_start and v_end;

  v_basis := jsonb_build_object(
    'timezone', 'Africa/Kampala',
    'plan_count', v_plan_count,
    'granularity', p_granularity,
    'period_start', v_start,
    'period_end', v_end,
    'scheduled_sources', jsonb_build_array('v_tenant_ops_tenant_base', 'rent_requests'),
    'collected_sources', jsonb_build_array('agent_collections'),
    'excluded_sources', jsonb_build_array('field_collections'),
    'finalised', p_finalise
  );

  insert into public.tppo_period_snapshots (
    granularity, period_start, period_end,
    scheduled_due_ugx, collected_ugx, plan_count,
    provisional, frozen_at, computed_at, basis
  ) values (
    p_granularity, v_start, v_end,
    v_scheduled, v_collected, v_plan_count,
    not p_finalise,
    case when p_finalise then now() else null end,
    now(), v_basis
  )
  on conflict (granularity, period_start) do update
    set period_end        = excluded.period_end,
        scheduled_due_ugx = excluded.scheduled_due_ugx,
        collected_ugx     = excluded.collected_ugx,
        plan_count        = excluded.plan_count,
        provisional       = excluded.provisional,
        frozen_at         = excluded.frozen_at,
        computed_at       = excluded.computed_at,
        basis             = excluded.basis
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.tppo_get_report_zone_a(
  p_granularity text,
  p_anchor date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
    'scheduled_due_ugx', v_cur.scheduled_due_ugx,
    'provisional', v_cur.provisional,
    'collection_rate_pct', v_rate,
    'threshold_pct', v_threshold,
    'below_threshold', case when v_rate is null then null else v_rate < v_threshold end,
    'prior', jsonb_build_object(
      'period_start', v_prior_start,
      'period_end', v_prior_end,
      'collected_ugx', v_prior.collected_ugx,
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
$$;