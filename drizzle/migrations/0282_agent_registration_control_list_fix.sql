CREATE OR REPLACE FUNCTION public.get_agent_registration_control(
  p_search text DEFAULT NULL,
  p_status text DEFAULT 'all',
  p_limit int DEFAULT 100,
  p_offset int DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_rules jsonb := public.agent_registration_gate_rules();
  v_min int := (v_rules->>'min_active_tenants')::int;
  v_req numeric := (v_rules->>'required_prev_month_pct')::numeric;
  v_rows jsonb;
  v_totals jsonb;
  v_hist jsonb;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR has_role(auth.uid(), 'manager') OR has_role(auth.uid(), 'super_admin')
    OR has_role(auth.uid(), 'ceo') OR has_role(auth.uid(), 'coo')
    OR has_role(auth.uid(), 'cfo') OR has_role(auth.uid(), 'cto')
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  WITH base AS (
    SELECT m.agent_id,
           pr.full_name,
           pr.phone,
           m.active_tenants, m.prev_expected, m.prev_collected, m.prev_pct,
           m.basis, m.period_start, m.period_end,
           (m.active_tenants >= v_min AND m.prev_pct IS NOT NULL AND m.prev_pct < v_req) AS restricted,
           (m.active_tenants >= v_min AND m.prev_pct IS NOT NULL AND m.prev_pct < v_req AND o.id IS NULL) AS blocked,
           o.id AS override_id, o.reason AS override_reason, ap.full_name AS override_by,
           o.created_at AS override_at, o.expires_at AS override_expires
    FROM public.agent_registration_gate_metrics(
           ARRAY(SELECT e.agent_id FROM public.v_agent_daily_eligibility e WHERE e.agent_id IS NOT NULL)
         ) m
    LEFT JOIN public.profiles pr ON pr.id = m.agent_id
    LEFT JOIN LATERAL (
      SELECT o2.* FROM public.agent_registration_gate_overrides o2
      WHERE o2.agent_id = m.agent_id AND o2.active
        AND (o2.expires_at IS NULL OR o2.expires_at > now())
      ORDER BY o2.created_at DESC LIMIT 1
    ) o ON true
    LEFT JOIN public.profiles ap ON ap.id = o.approved_by
  ),
  tot AS (
    SELECT jsonb_build_object(
      'agents', count(*),
      'at_threshold', count(*) FILTER (WHERE active_tenants >= v_min),
      'restricted', count(*) FILTER (WHERE restricted),
      'blocked', count(*) FILTER (WHERE blocked),
      'overridden', count(*) FILTER (WHERE restricted AND override_id IS NOT NULL)
    ) AS j FROM base
  ),
  page AS (
    SELECT * FROM base
    WHERE (p_status = 'all'
           OR (p_status = 'blocked' AND blocked)
           OR (p_status = 'restricted' AND restricted)
           OR (p_status = 'overridden' AND restricted AND override_id IS NOT NULL)
           OR (p_status = 'clear' AND NOT restricted))
      AND (p_search IS NULL OR btrim(p_search) = ''
           OR full_name ILIKE '%' || btrim(p_search) || '%'
           OR phone ILIKE '%' || btrim(p_search) || '%')
    ORDER BY blocked DESC, restricted DESC, active_tenants DESC
    LIMIT GREATEST(COALESCE(p_limit, 100), 1) OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT (SELECT j FROM tot),
         COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM page p), '[]'::jsonb)
  INTO v_totals, v_rows;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', o.id, 'agent_id', o.agent_id, 'agent_name', pr.full_name,
    'approved_by', o.approved_by, 'approved_by_name', ap.full_name,
    'reason', o.reason, 'previous_state', o.previous_state, 'new_state', o.new_state,
    'active', (o.active AND (o.expires_at IS NULL OR o.expires_at > now())),
    'expires_at', o.expires_at, 'created_at', o.created_at,
    'revoked_at', o.revoked_at, 'revoke_reason', o.revoke_reason
  ) ORDER BY o.created_at DESC), '[]'::jsonb)
  INTO v_hist
  FROM public.agent_registration_gate_overrides o
  LEFT JOIN public.profiles pr ON pr.id = o.agent_id
  LEFT JOIN public.profiles ap ON ap.id = o.approved_by
  WHERE o.created_at > now() - interval '180 days';

  RETURN jsonb_build_object(
    'as_of', now(),
    'rules', v_rules,
    'totals', v_totals,
    'rows', v_rows,
    'overrides', v_hist
  );
END;
$$;
