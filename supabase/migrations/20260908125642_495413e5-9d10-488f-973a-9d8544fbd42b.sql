CREATE OR REPLACE FUNCTION public.tenant_location_correction_dashboard(p_agent_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF NOT public.is_ops_role(v_actor) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  WITH base AS (
    -- Same population as tenant_location_correction_agents: latest request decides the handling agent.
    SELECT DISTINCT ON (r.tenant_id)
      r.tenant_id,
      coalesce(r.agent_id, r.assigned_agent_id) AS agent_id
    FROM public.rent_requests r
    WHERE r.tenant_id IS NOT NULL
    ORDER BY r.tenant_id, r.created_at DESC
  ), pop AS (
    SELECT b.tenant_id, b.agent_id, (tp.ug_village_id IS NULL) AS outstanding
    FROM base b
    JOIN public.profiles tp ON tp.id = b.tenant_id
    WHERE p_agent_id IS NULL OR b.agent_id = p_agent_id
  ), corr AS (
    -- Real saved corrections (audit trail written by correct_tenant_location).
    SELECT
      al.record_id::uuid AS tenant_id,
      al.user_id AS actor_id,
      al.created_at,
      (al.created_at AT TIME ZONE 'Africa/Kampala')::date AS day,
      p.agent_id
    FROM public.audit_logs al
    JOIN pop p ON p.tenant_id::text = al.record_id
    WHERE al.action_type = 'tenant.location_corrected'
  ), corr_first AS (
    SELECT tenant_id, agent_id, min(created_at) AS first_at, min(day) AS first_day
    FROM corr GROUP BY tenant_id, agent_id
  ), per_agent AS (
    SELECT
      p.agent_id,
      ap.full_name AS agent_name,
      ap.phone AS agent_phone,
      count(*)::int AS total_tenants,
      count(*) FILTER (WHERE p.outstanding)::int AS outstanding,
      count(cf.tenant_id)::int AS corrected
    FROM pop p
    LEFT JOIN corr_first cf ON cf.tenant_id = p.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = p.agent_id
    WHERE p.agent_id IS NOT NULL
    GROUP BY p.agent_id, ap.full_name, ap.phone
    HAVING count(*) FILTER (WHERE p.outstanding) > 0 OR count(cf.tenant_id) > 0
  ), agent_rows AS (
    SELECT jsonb_build_object(
      'agent_id', agent_id, 'agent_name', agent_name, 'agent_phone', agent_phone,
      'total_tenants', total_tenants, 'outstanding', outstanding, 'corrected', corrected,
      'required', outstanding + corrected,
      'pct', CASE WHEN outstanding + corrected > 0 THEN round(corrected::numeric * 100 / (outstanding + corrected), 1) ELSE 0 END
    ) AS j, agent_id, outstanding, corrected, total_tenants
    FROM per_agent
  ), days AS (
    SELECT d::date AS day FROM generate_series(v_today - 89, v_today, interval '1 day') d
  ), daily AS (
    SELECT
      d.day,
      count(c.tenant_id)::int AS corrections,
      count(DISTINCT c.tenant_id)::int AS tenants,
      count(DISTINCT c.actor_id)::int AS actors,
      count(DISTINCT c.agent_id)::int AS agents
    FROM days d
    LEFT JOIN corr c ON c.day = d.day
    GROUP BY d.day
  ), totals AS (
    SELECT
      (SELECT count(*) FROM pop)::int AS total_tenants,
      (SELECT count(*) FROM pop WHERE outstanding)::int AS outstanding,
      (SELECT count(*) FROM corr_first)::int AS corrected,
      (SELECT count(DISTINCT tenant_id) FROM corr WHERE day = v_today)::int AS corrected_today,
      (SELECT count(DISTINCT tenant_id) FROM corr WHERE day >= date_trunc('week', v_today)::date)::int AS corrected_week,
      (SELECT count(DISTINCT tenant_id) FROM corr WHERE day >= date_trunc('month', v_today)::date)::int AS corrected_month,
      (SELECT count(*) FROM per_agent WHERE outstanding > 0)::int AS agents_outstanding,
      (SELECT count(*) FROM per_agent WHERE outstanding = 0 AND corrected > 0)::int AS agents_completed,
      (SELECT count(*) FROM per_agent)::int AS agents_involved,
      (SELECT count(DISTINCT agent_id) FROM pop WHERE agent_id IS NOT NULL)::int AS agents_total
  )
  SELECT jsonb_build_object(
    'as_of_day', v_today,
    'total_tenants', t.total_tenants,
    'outstanding', t.outstanding,
    'corrected', t.corrected,
    'required', t.outstanding + t.corrected,
    'corrected_today', t.corrected_today,
    'corrected_week', t.corrected_week,
    'corrected_month', t.corrected_month,
    'agents_outstanding', t.agents_outstanding,
    'agents_completed', t.agents_completed,
    'agents_involved', t.agents_involved,
    'agents_total', t.agents_total,
    'avg_corrections_per_agent', CASE WHEN t.agents_involved > 0 THEN round(t.corrected::numeric / t.agents_involved, 1) ELSE 0 END,
    'top_progress', coalesce((SELECT jsonb_agg(j) FROM (SELECT j FROM agent_rows WHERE corrected > 0 ORDER BY (j->>'pct')::numeric DESC, corrected DESC LIMIT 8) s), '[]'::jsonb),
    'top_outstanding', coalesce((SELECT jsonb_agg(j) FROM (SELECT j FROM agent_rows WHERE outstanding > 0 ORDER BY outstanding DESC LIMIT 8) s), '[]'::jsonb),
    'agents', coalesce((SELECT jsonb_agg(j) FROM (SELECT j FROM agent_rows ORDER BY outstanding DESC, corrected DESC LIMIT 300) s), '[]'::jsonb),
    'daily', coalesce((SELECT jsonb_agg(jsonb_build_object('day', day, 'corrections', corrections, 'tenants', tenants, 'actors', actors, 'agents', agents) ORDER BY day) FROM daily), '[]'::jsonb)
  ) INTO v_result
  FROM totals t;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.tenant_location_correction_dashboard(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tenant_location_correction_dashboard(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_location_correction_dashboard(uuid) TO service_role;