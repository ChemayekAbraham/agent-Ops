CREATE OR REPLACE FUNCTION public.get_agent_leaderboard_stats(p_period text DEFAULT 'monthly')
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trunc text;
  v_start timestamptz;
  v_prev_start timestamptz;
  v_totals jsonb;
  v_series jsonb;
  v_top jsonb;
  v_invitees jsonb;
  v_prev_agents int;
  v_prev_subagents int;
BEGIN
  IF p_period = 'daily' THEN
    v_trunc := 'day';   v_start := date_trunc('day', now())   - interval '29 days';
    v_prev_start := v_start - interval '30 days';
  ELSIF p_period = 'weekly' THEN
    v_trunc := 'week';  v_start := date_trunc('week', now())  - interval '11 weeks';
    v_prev_start := v_start - interval '12 weeks';
  ELSIF p_period = 'yearly' THEN
    v_trunc := 'year';  v_start := date_trunc('year', now())  - interval '4 years';
    v_prev_start := v_start - interval '5 years';
  ELSE
    p_period := 'monthly';
    v_trunc := 'month'; v_start := date_trunc('month', now()) - interval '11 months';
    v_prev_start := v_start - interval '12 months';
  END IF;

  SELECT count(*) INTO v_prev_agents
  FROM public.user_roles
  WHERE role = 'agent' AND coalesce(enabled, true)
    AND created_at >= v_prev_start AND created_at < v_start;

  SELECT count(*) INTO v_prev_subagents
  FROM public.agent_subagents
  WHERE created_at >= v_prev_start AND created_at < v_start;

  SELECT jsonb_build_object(
    'total_agents',       (SELECT count(*) FROM public.user_roles WHERE role='agent' AND coalesce(enabled,true)),
    'total_subagents',    (SELECT count(*) FROM public.agent_subagents),
    'verified_subagents', (SELECT count(*) FROM public.agent_subagents WHERE status='verified'),
    'pending_subagents',  (SELECT count(*) FROM public.agent_subagents WHERE status='pending_acceptance'),
    'new_agents',         (SELECT count(*) FROM public.user_roles WHERE role='agent' AND coalesce(enabled,true) AND created_at >= v_start),
    'new_subagents',      (SELECT count(*) FROM public.agent_subagents WHERE created_at >= v_start),
    'prev_agents',        v_prev_agents,
    'prev_subagents',     v_prev_subagents
  ) INTO v_totals;

  WITH buckets AS (
    SELECT generate_series(v_start, date_trunc(v_trunc, now()), ('1 ' || v_trunc)::interval) AS b
  ),
  ag AS (
    SELECT date_trunc(v_trunc, created_at) AS b, count(*) AS c
    FROM public.user_roles
    WHERE role='agent' AND coalesce(enabled,true) AND created_at >= v_start
    GROUP BY 1
  ),
  sa AS (
    SELECT date_trunc(v_trunc, created_at) AS b, count(*) AS c
    FROM public.agent_subagents
    WHERE created_at >= v_start
    GROUP BY 1
  )
  SELECT jsonb_agg(jsonb_build_object(
    'bucket', buckets.b,
    'agents', coalesce(ag.c, 0),
    'subagents', coalesce(sa.c, 0)
  ) ORDER BY buckets.b)
  INTO v_series
  FROM buckets
  LEFT JOIN ag ON ag.b = buckets.b
  LEFT JOIN sa ON sa.b = buckets.b;

  SELECT jsonb_agg(x) INTO v_top FROM (
    SELECT s.parent_agent_id AS agent_id,
           coalesce(p.full_name, left(s.parent_agent_id::text, 8)) AS name,
           p.avatar_url,
           p.phone,
           count(*)::int AS invited,
           count(*) FILTER (WHERE s.status='verified')::int AS verified
    FROM public.agent_subagents s
    LEFT JOIN public.profiles p ON p.id = s.parent_agent_id
    WHERE s.created_at >= v_start
    GROUP BY s.parent_agent_id, p.full_name, p.avatar_url, p.phone
    ORDER BY count(*) DESC, count(*) FILTER (WHERE s.status='verified') DESC
    LIMIT 10
  ) x;

  SELECT jsonb_agg(y) INTO v_invitees FROM (
    SELECT s.id,
           s.sub_agent_id,
           s.parent_agent_id,
           coalesce(sp.full_name, left(s.sub_agent_id::text, 8)) AS sub_agent_name,
           sp.phone AS sub_agent_phone,
           coalesce(pp.full_name, left(s.parent_agent_id::text, 8)) AS parent_name,
           s.status,
           s.created_at,
           s.verified_at
    FROM public.agent_subagents s
    LEFT JOIN public.profiles sp ON sp.id = s.sub_agent_id
    LEFT JOIN public.profiles pp ON pp.id = s.parent_agent_id
    WHERE s.created_at >= v_start
    ORDER BY s.created_at DESC
    LIMIT 150
  ) y;

  RETURN jsonb_build_object(
    'period', p_period,
    'window_start', v_start,
    'totals', v_totals,
    'series', coalesce(v_series, '[]'::jsonb),
    'top_recruiters', coalesce(v_top, '[]'::jsonb),
    'invitees', coalesce(v_invitees, '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_leaderboard_stats(text) TO authenticated, service_role;