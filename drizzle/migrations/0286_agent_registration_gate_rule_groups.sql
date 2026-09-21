-- Agent Registration Control: configurable rule groups.
-- Ops/management can define one or more rule groups, each with its own tenant-count
-- band, required previous-month percentage, and optional filters (district, region,
-- agent level, hand-picked agents). The first active matching group applies.

CREATE OR REPLACE FUNCTION public.agent_registration_gate_rules()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_defaults jsonb := jsonb_build_object(
    'enabled', true,
    'min_active_tenants', 20,
    'required_prev_month_pct', 80,
    'groups', '[]'::jsonb
  );
  v_stored jsonb;
  v_out jsonb;
BEGIN
  SELECT value INTO v_stored FROM public.system_config WHERE key = 'agent_registration_gate_rules';
  IF v_stored IS NULL OR jsonb_typeof(v_stored) <> 'object' THEN
    v_out := v_defaults;
  ELSE
    v_out := v_defaults || v_stored;
  END IF;

  IF jsonb_typeof(v_out->'groups') <> 'array' OR jsonb_array_length(v_out->'groups') = 0 THEN
    v_out := jsonb_set(v_out, '{groups}', jsonb_build_array(jsonb_build_object(
      'id', 'default',
      'label', 'All agents',
      'active', true,
      'min_active_tenants', (v_out->>'min_active_tenants')::int,
      'max_active_tenants', NULL,
      'required_prev_month_pct', (v_out->>'required_prev_month_pct')::numeric,
      'districts', '[]'::jsonb,
      'regions', '[]'::jsonb,
      'tiers', '[]'::jsonb,
      'agent_ids', '[]'::jsonb
    )));
  END IF;

  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_agent_registration_gate_rules(p_rules jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_enabled boolean;
  v_groups jsonb := '[]'::jsonb;
  v_g jsonb;
  v_min int;
  v_max int;
  v_pct numeric;
  v_i int := 0;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR has_role(auth.uid(), 'manager') OR has_role(auth.uid(), 'super_admin')
    OR has_role(auth.uid(), 'ceo') OR has_role(auth.uid(), 'coo')
    OR has_role(auth.uid(), 'cfo')
  ) THEN
    RAISE EXCEPTION 'Only operations and management can change the registration control rules';
  END IF;

  v_enabled := COALESCE((p_rules->>'enabled')::boolean, true);

  IF jsonb_typeof(p_rules->'groups') = 'array' THEN
    FOR v_g IN SELECT * FROM jsonb_array_elements(p_rules->'groups') LOOP
      v_i := v_i + 1;
      v_min := COALESCE((v_g->>'min_active_tenants')::int, 20);
      v_max := NULLIF(v_g->>'max_active_tenants', '')::int;
      v_pct := COALESCE((v_g->>'required_prev_month_pct')::numeric, 80);

      IF v_min < 0 THEN
        RAISE EXCEPTION 'Group %: the tenant count cannot be negative', v_i;
      END IF;
      IF v_max IS NOT NULL AND v_max < v_min THEN
        RAISE EXCEPTION 'Group %: the upper tenant count must not be below the lower one', v_i;
      END IF;
      IF v_pct < 0 OR v_pct > 100 THEN
        RAISE EXCEPTION 'Group %: the required percentage must be between 0 and 100', v_i;
      END IF;

      v_groups := v_groups || jsonb_build_array(jsonb_build_object(
        'id', COALESCE(NULLIF(v_g->>'id', ''), gen_random_uuid()::text),
        'label', COALESCE(NULLIF(btrim(v_g->>'label'), ''), 'Group ' || v_i),
        'active', COALESCE((v_g->>'active')::boolean, true),
        'min_active_tenants', v_min,
        'max_active_tenants', v_max,
        'required_prev_month_pct', v_pct,
        'districts', COALESCE(CASE WHEN jsonb_typeof(v_g->'districts') = 'array' THEN v_g->'districts' END, '[]'::jsonb),
        'regions', COALESCE(CASE WHEN jsonb_typeof(v_g->'regions') = 'array' THEN v_g->'regions' END, '[]'::jsonb),
        'tiers', COALESCE(CASE WHEN jsonb_typeof(v_g->'tiers') = 'array' THEN v_g->'tiers' END, '[]'::jsonb),
        'agent_ids', COALESCE(CASE WHEN jsonb_typeof(v_g->'agent_ids') = 'array' THEN v_g->'agent_ids' END, '[]'::jsonb)
      ));
    END LOOP;
  END IF;

  IF jsonb_array_length(v_groups) = 0 THEN
    v_min := COALESCE((p_rules->>'min_active_tenants')::int, 20);
    v_pct := COALESCE((p_rules->>'required_prev_month_pct')::numeric, 80);
    IF v_min < 1 THEN RAISE EXCEPTION 'The tenant count must be at least 1'; END IF;
    IF v_pct < 0 OR v_pct > 100 THEN RAISE EXCEPTION 'The required percentage must be between 0 and 100'; END IF;
    v_groups := jsonb_build_array(jsonb_build_object(
      'id', 'default', 'label', 'All agents', 'active', true,
      'min_active_tenants', v_min, 'max_active_tenants', NULL,
      'required_prev_month_pct', v_pct,
      'districts', '[]'::jsonb, 'regions', '[]'::jsonb, 'tiers', '[]'::jsonb, 'agent_ids', '[]'::jsonb
    ));
  END IF;

  INSERT INTO public.system_config (key, value)
  VALUES ('agent_registration_gate_rules', jsonb_build_object(
    'enabled', v_enabled,
    'min_active_tenants', (v_groups->0->>'min_active_tenants')::int,
    'required_prev_month_pct', (v_groups->0->>'required_prev_month_pct')::numeric,
    'groups', v_groups
  ))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  RETURN public.agent_registration_gate_rules();
END;
$$;

CREATE OR REPLACE FUNCTION public.agent_registration_gate_group(
  p_rules jsonb,
  p_active_tenants int,
  p_district text,
  p_region text,
  p_tier text,
  p_agent_id uuid
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT g.grp
  FROM jsonb_array_elements(COALESCE(p_rules->'groups', '[]'::jsonb)) WITH ORDINALITY AS g(grp, ord)
  WHERE COALESCE((p_rules->>'enabled')::boolean, true)
    AND COALESCE((g.grp->>'active')::boolean, true)
    AND COALESCE(p_active_tenants, 0) >= COALESCE((g.grp->>'min_active_tenants')::int, 0)
    AND (NULLIF(g.grp->>'max_active_tenants', '') IS NULL
         OR COALESCE(p_active_tenants, 0) <= (g.grp->>'max_active_tenants')::int)
    AND (jsonb_typeof(g.grp->'districts') <> 'array' OR jsonb_array_length(g.grp->'districts') = 0
         OR lower(btrim(COALESCE(p_district, ''))) IN (
              SELECT lower(btrim(d)) FROM jsonb_array_elements_text(g.grp->'districts') d))
    AND (jsonb_typeof(g.grp->'regions') <> 'array' OR jsonb_array_length(g.grp->'regions') = 0
         OR lower(btrim(COALESCE(p_region, ''))) IN (
              SELECT lower(btrim(r)) FROM jsonb_array_elements_text(g.grp->'regions') r))
    AND (jsonb_typeof(g.grp->'tiers') <> 'array' OR jsonb_array_length(g.grp->'tiers') = 0
         OR lower(btrim(COALESCE(p_tier, ''))) IN (
              SELECT lower(btrim(t)) FROM jsonb_array_elements_text(g.grp->'tiers') t))
    AND (jsonb_typeof(g.grp->'agent_ids') <> 'array' OR jsonb_array_length(g.grp->'agent_ids') = 0
         OR p_agent_id::text IN (
              SELECT btrim(a) FROM jsonb_array_elements_text(g.grp->'agent_ids') a))
  ORDER BY g.ord
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.agent_registration_gate_status(p_agent_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_agent uuid := COALESCE(p_agent_id, auth.uid());
  v_rules jsonb := public.agent_registration_gate_rules();
  v_grp jsonb;
  v_min int;
  v_req numeric;
  v_m record;
  v_p record;
  v_ov record;
  v_blocked boolean := false;
  v_reason text := null;
BEGIN
  IF v_agent IS NULL THEN
    RAISE EXCEPTION 'No agent specified';
  END IF;

  IF current_setting('role', true) IS DISTINCT FROM 'service_role'
     AND auth.uid() IS DISTINCT FROM v_agent
     AND NOT (
       public.is_ops_role(auth.uid())
       OR has_role(auth.uid(), 'manager') OR has_role(auth.uid(), 'super_admin')
       OR has_role(auth.uid(), 'ceo') OR has_role(auth.uid(), 'coo')
       OR has_role(auth.uid(), 'cfo') OR has_role(auth.uid(), 'cto')
     ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT * INTO v_m FROM public.agent_registration_gate_metrics(ARRAY[v_agent]) LIMIT 1;
  SELECT district, region, agent_tier::text AS tier INTO v_p
  FROM public.profiles WHERE id = v_agent;

  v_grp := public.agent_registration_gate_group(
    v_rules, COALESCE(v_m.active_tenants, 0), v_p.district, v_p.region, v_p.tier, v_agent);

  v_min := (v_grp->>'min_active_tenants')::int;
  v_req := (v_grp->>'required_prev_month_pct')::numeric;

  SELECT * INTO v_ov
  FROM public.agent_registration_gate_overrides o
  WHERE o.agent_id = v_agent
    AND o.active
    AND (o.expires_at IS NULL OR o.expires_at > now())
  ORDER BY o.created_at DESC
  LIMIT 1;

  IF v_grp IS NOT NULL
     AND v_m.prev_pct IS NOT NULL
     AND v_m.prev_pct < v_req THEN
    v_blocked := true;
    v_reason := format(
      'Registration is restricted. You have %s active tenants (the limit is %s) and your %s collection performance was %s%%, below the required %s%%. Collect more from the tenants you already have to lift the restriction.',
      COALESCE(v_m.active_tenants, 0), v_min, to_char(v_m.period_start, 'FMMonth YYYY'),
      trim(to_char(v_m.prev_pct, 'FM999990.0')), trim(to_char(v_req, 'FM999990.0'))
    );
  END IF;

  RETURN jsonb_build_object(
    'agent_id', v_agent,
    'active_tenants', COALESCE(v_m.active_tenants, 0),
    'min_active_tenants', v_min,
    'prev_month_pct', v_m.prev_pct,
    'required_prev_month_pct', v_req,
    'prev_month_expected', COALESCE(v_m.prev_expected, 0),
    'prev_month_collected', COALESCE(v_m.prev_collected, 0),
    'period_start', v_m.period_start,
    'period_end', v_m.period_end,
    'basis', v_m.basis,
    'group_id', v_grp->>'id',
    'group_label', v_grp->>'label',
    'restricted', v_blocked,
    'blocked', v_blocked AND v_ov.id IS NULL,
    'reason', v_reason,
    'override', CASE WHEN v_ov.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_ov.id,
      'approved_by', v_ov.approved_by,
      'reason', v_ov.reason,
      'expires_at', v_ov.expires_at,
      'created_at', v_ov.created_at
    ) END,
    'checked_at', now()
  );
END;
$$;

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
  v_rows jsonb;
  v_totals jsonb;
  v_hist jsonb;
  v_options jsonb;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR has_role(auth.uid(), 'manager') OR has_role(auth.uid(), 'super_admin')
    OR has_role(auth.uid(), 'ceo') OR has_role(auth.uid(), 'coo')
    OR has_role(auth.uid(), 'cfo') OR has_role(auth.uid(), 'cto')
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  WITH metrics AS (
    SELECT m.*
    FROM public.agent_registration_gate_metrics(
           ARRAY(SELECT e.agent_id FROM public.v_agent_daily_eligibility e WHERE e.agent_id IS NOT NULL)
         ) m
  ),
  base AS (
    SELECT m.agent_id,
           pr.full_name,
           pr.phone,
           pr.district,
           pr.region,
           pr.agent_tier::text AS tier,
           m.active_tenants, m.prev_expected, m.prev_collected, m.prev_pct,
           m.basis, m.period_start, m.period_end,
           g.grp->>'id' AS group_id,
           g.grp->>'label' AS group_label,
           (g.grp->>'min_active_tenants')::int AS group_min_active_tenants,
           (g.grp->>'required_prev_month_pct')::numeric AS group_required_pct,
           (g.grp IS NOT NULL) AS in_scope,
           (g.grp IS NOT NULL AND m.prev_pct IS NOT NULL
              AND m.prev_pct < (g.grp->>'required_prev_month_pct')::numeric) AS restricted,
           (g.grp IS NOT NULL AND m.prev_pct IS NOT NULL
              AND m.prev_pct < (g.grp->>'required_prev_month_pct')::numeric
              AND o.id IS NULL) AS blocked,
           o.id AS override_id, o.reason AS override_reason, ap.full_name AS override_by,
           o.created_at AS override_at, o.expires_at AS override_expires
    FROM metrics m
    LEFT JOIN public.profiles pr ON pr.id = m.agent_id
    LEFT JOIN LATERAL (
      SELECT public.agent_registration_gate_group(
        v_rules, m.active_tenants, pr.district, pr.region, pr.agent_tier::text, m.agent_id) AS grp
    ) g ON true
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
      'at_threshold', count(*) FILTER (WHERE in_scope),
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
  ),
  opts AS (
    SELECT jsonb_build_object(
      'districts', COALESCE((SELECT jsonb_agg(DISTINCT btrim(district)) FROM base
                             WHERE COALESCE(btrim(district), '') <> ''), '[]'::jsonb),
      'regions', COALESCE((SELECT jsonb_agg(DISTINCT btrim(region)) FROM base
                           WHERE COALESCE(btrim(region), '') <> ''), '[]'::jsonb),
      'tiers', COALESCE((SELECT jsonb_agg(DISTINCT tier) FROM base
                         WHERE COALESCE(btrim(tier), '') <> ''), '[]'::jsonb),
      'agents', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                            'agent_id', b.agent_id, 'full_name', b.full_name,
                            'active_tenants', b.active_tenants) ORDER BY b.full_name)
                          FROM base b), '[]'::jsonb)
    ) AS j
  )
  SELECT (SELECT j FROM tot),
         COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM page p), '[]'::jsonb),
         (SELECT j FROM opts)
  INTO v_totals, v_rows, v_options;

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
    'options', v_options,
    'overrides', v_hist
  );
END;
$$;