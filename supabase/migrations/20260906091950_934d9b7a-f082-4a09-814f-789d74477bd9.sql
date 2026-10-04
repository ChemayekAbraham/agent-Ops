create or replace function public.tppo_projection_zone_a(p_granularity text, p_as_at date)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_horizon integer;
  v_start date;
  v_rows jsonb;
  v_total numeric;
begin
  if p_granularity not in ('day', 'week', 'month') then
    raise exception 'tppo_projection_zone_a: unsupported granularity %', p_granularity;
  end if;

  v_horizon := case p_granularity when 'day' then 7 when 'week' then 4 else 3 end;
  v_start := p_as_at + 1;

  with periods as (
    select i as period_index,
      case p_granularity
        when 'day'   then v_start + (i - 1)
        when 'week'  then ((select b.period_start from public.tppo_period_bounds('week', v_start) b) + ((i - 1) * 7))::date
        else (date_trunc('month', v_start::timestamp) + ((i - 1) * interval '1 month'))::date
      end as p_start,
      case p_granularity
        when 'day'   then v_start + (i - 1)
        when 'week'  then ((select b.period_start from public.tppo_period_bounds('week', v_start) b) + ((i - 1) * 7) + 6)::date
        else (date_trunc('month', v_start::timestamp) + (i * interval '1 month') - interval '1 day')::date
      end as p_end
    from generate_series(1, v_horizon) as i
  ), amounts as (
    select p.period_index, p.p_start, p.p_end,
      coalesce((select sum(g.amount)
                from public.rent_plan_schedule_days(greatest(p.p_start, v_start), p.p_end) g), 0) as projected_ugx,
      coalesce((select count(distinct g.rent_request_id)
                from public.rent_plan_schedule_days(greatest(p.p_start, v_start), p.p_end) g), 0) as plans
    from periods p
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'period_index', a.period_index,
      'period_start', a.p_start,
      'period_end', a.p_end,
      'label', case p_granularity
                 when 'day'   then to_char(a.p_start, 'Dy DD Mon')
                 when 'week'  then 'Wk of ' || to_char(a.p_start, 'DD Mon')
                 else to_char(a.p_start, 'Mon YYYY')
               end,
      'projected_ugx', a.projected_ugx,
      'plans', a.plans
    ) order by a.period_index), '[]'::jsonb),
    coalesce(sum(a.projected_ugx), 0)
  into v_rows, v_total
  from amounts a;

  return jsonb_build_object(
    'granularity', p_granularity,
    'as_at', p_as_at,
    'snapshot_as_at', null,
    'horizon', v_horizon,
    'available', true,
    'reason', null,
    'basis', 'rent_plan_schedule_days',
    'periods', v_rows,
    'total_ugx', v_total
  );
end;
$function$;

comment on function public.tppo_projection_zone_a(text, date) is
  'Forward view of what the agreed payment plans fall due, derived from rent_plan_schedule_days so it honours each plan repayment_starts_on, its daily, weekly or monthly cadence, and its obligation window. This is scheduled rent, not a modelled collections forecast. The receivables_forecast_snapshots model is left in place and is no longer read here.';