CREATE OR REPLACE FUNCTION public.get_agent_weekly_growth_forecast(p_ref date DEFAULT (now() AT TIME ZONE 'Africa/Nairobi')::date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_week_start date;         -- Monday of the current week (EAT)
  v_last_week_start date;    -- Monday of last week
  v_trail_start date;        -- start of trailing 4 completed weeks
  v_ws_utc timestamptz;
  v_lws_utc timestamptz;
  v_trail_utc timestamptz;
  -- agents
  v_agents_now int;
  v_agents_end_last_week int;
  v_new_agents_this_week int;
  v_new_agents_last_week int;
  v_new_agents_trailing int;
  v_avg_agents_wk numeric;
  v_forecast_agents int;
  -- sub-agents
  v_subs_now int;
  v_subs_end_last_week int;
  v_new_subs_this_week int;
  v_new_subs_last_week int;
  v_new_subs_trailing int;
  v_avg_subs_wk numeric;
  v_forecast_subs int;
BEGIN
  v_week_start := date_trunc('week', p_ref::timestamp)::date;   -- Monday
  v_last_week_start := v_week_start - 7;
  v_trail_start := v_week_start - 28;                            -- 4 completed weeks

  v_ws_utc    := (v_week_start::timestamp AT TIME ZONE 'UTC') - interval '3 hours';
  v_lws_utc   := (v_last_week_start::timestamp AT TIME ZONE 'UTC') - interval '3 hours';
  v_trail_utc := (v_trail_start::timestamp AT TIME ZONE 'UTC') - interval '3 hours';

  -- Agents: cumulative counts anchored to profile join date.
  WITH qa AS (
    SELECT p.created_at
    FROM public.agent_ops_qualifying_agent_ids() q
    JOIN public.profiles p ON p.id = q.agent_id
  )
  SELECT
    count(*),
    count(*) FILTER (WHERE created_at < v_ws_utc),
    count(*) FILTER (WHERE created_at >= v_ws_utc),
    count(*) FILTER (WHERE created_at >= v_lws_utc AND created_at < v_ws_utc),
    count(*) FILTER (WHERE created_at >= v_trail_utc AND created_at < v_ws_utc)
  INTO v_agents_now, v_agents_end_last_week, v_new_agents_this_week, v_new_agents_last_week, v_new_agents_trailing
  FROM qa;

  -- Sub-agents.
  SELECT
    count(*),
    count(*) FILTER (WHERE created_at < v_ws_utc),
    count(*) FILTER (WHERE created_at >= v_ws_utc),
    count(*) FILTER (WHERE created_at >= v_lws_utc AND created_at < v_ws_utc),
    count(*) FILTER (WHERE created_at >= v_trail_utc AND created_at < v_ws_utc)
  INTO v_subs_now, v_subs_end_last_week, v_new_subs_this_week, v_new_subs_last_week, v_new_subs_trailing
  FROM public.agent_subagents;

  v_avg_agents_wk := round(v_new_agents_trailing::numeric / 4.0, 1);
  v_avg_subs_wk   := round(v_new_subs_trailing::numeric / 4.0, 1);
  v_forecast_agents := v_agents_now + round(v_avg_agents_wk)::int;
  v_forecast_subs   := v_subs_now + round(v_avg_subs_wk)::int;

  RETURN jsonb_build_object(
    'week_start', v_week_start,
    'last_week_start', v_last_week_start,
    'agents', jsonb_build_object(
      'last_week', v_agents_end_last_week,
      'now', v_agents_now,
      'new_this_week', v_new_agents_this_week,
      'new_last_week', v_new_agents_last_week,
      'avg_weekly_new', v_avg_agents_wk,
      'next_week_forecast', v_forecast_agents
    ),
    'subagents', jsonb_build_object(
      'last_week', v_subs_end_last_week,
      'now', v_subs_now,
      'new_this_week', v_new_subs_this_week,
      'new_last_week', v_new_subs_last_week,
      'avg_weekly_new', v_avg_subs_wk,
      'next_week_forecast', v_forecast_subs
    )
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_agent_weekly_growth_forecast(date) TO authenticated, service_role;