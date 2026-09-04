create or replace function public.tppo_projection_zone_a(
  p_granularity text,
  p_as_at date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_horizon integer;
  v_start date;
  v_as_at date;
  v_rows jsonb;
  v_total numeric;
  v_have boolean;
begin
  if p_granularity not in ('day', 'week', 'month') then
    raise exception 'tppo_projection_zone_a: unsupported granularity %', p_granularity;
  end if;

  v_horizon := case p_granularity when 'day' then 7 when 'week' then 4 else 3 end;
  v_start := p_as_at + 1;

  select max(s.as_at)
    into v_as_at
  from public.receivables_forecast_snapshots s
  where s.granularity = p_granularity
    and s.as_at <= p_as_at;

  v_have := v_as_at is not null;

  if v_have then
    select
      coalesce(jsonb_agg(
        jsonb_build_object(
          'period_index', t.period_index,
          'period_start', t.period_start,
          'period_end', t.period_end,
          'label', t.label,
          'projected_ugx', t.projected_ugx
        )
        order by t.period_index
      ), '[]'::jsonb),
      coalesce(sum(t.projected_ugx), 0)
    into v_rows, v_total
    from (
      select
        s.period_index,
        s.period_start,
        s.period_end,
        case p_granularity
          when 'day'   then to_char(s.period_start, 'Dy DD Mon')
          when 'week'  then 'Wk of ' || to_char(s.period_start, 'DD Mon')
          else to_char(s.period_start, 'Mon YYYY')
        end as label,
        s.forecast_amount as projected_ugx
      from public.receivables_forecast_snapshots s
      where s.granularity = p_granularity
        and s.as_at = v_as_at
        and s.period_start >= v_start
      order by s.period_index
      limit v_horizon
    ) t;
  else
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'period_index', g.i,
        'period_start', g.p_start,
        'period_end', g.p_end,
        'label', case p_granularity
                   when 'day'   then to_char(g.p_start, 'Dy DD Mon')
                   when 'week'  then 'Wk of ' || to_char(g.p_start, 'DD Mon')
                   else to_char(g.p_start, 'Mon YYYY')
                 end,
        'projected_ugx', null
      )
      order by g.i
    ), '[]'::jsonb)
    into v_rows
    from (
      select
        i,
        case p_granularity
          when 'day'   then v_start + (i - 1)
          when 'week'  then (date_trunc('week', v_start::timestamp) + ((i - 1) * interval '7 days'))::date
          else (date_trunc('month', v_start::timestamp) + ((i - 1) * interval '1 month'))::date
        end as p_start,
        case p_granularity
          when 'day'   then v_start + (i - 1)
          when 'week'  then (date_trunc('week', v_start::timestamp) + ((i - 1) * interval '7 days') + interval '6 days')::date
          else (date_trunc('month', v_start::timestamp) + (i * interval '1 month') - interval '1 day')::date
        end as p_end
      from generate_series(1, v_horizon) as i
    ) g;

    v_total := null;
  end if;

  return jsonb_build_object(
    'granularity', p_granularity,
    'as_at', p_as_at,
    'snapshot_as_at', v_as_at,
    'horizon', v_horizon,
    'available', v_have,
    'reason', case when v_have then null else 'no forecast snapshot for this granularity' end,
    'periods', v_rows,
    'total_ugx', v_total
  );
end;
$$;