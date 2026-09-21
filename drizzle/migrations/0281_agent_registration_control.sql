-- Agent Registration Control: 20+ active tenants with previous-month performance
-- below the required threshold blocks new tenant registration, unless a
-- management override is on record. Reuses the authoritative active-tenant count
-- (v_agent_daily_eligibility.active_count), the authoritative collected figure
-- (agent_ops_report_collected) and the authoritative plan schedule
-- (v_rent_plan_schedule / agent_expected_day_plans pins) for expected.

CREATE TABLE IF NOT EXISTS public.agent_registration_gate_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  approved_by uuid NOT NULL,
  reason text NOT NULL,
  previous_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_reg_override_reason_ck CHECK (char_length(btrim(reason)) >= 10)
);

CREATE INDEX IF NOT EXISTS idx_agent_reg_override_agent
  ON public.agent_registration_gate_overrides (agent_id, active, created_at DESC);

GRANT SELECT ON public.agent_registration_gate_overrides TO authenticated;
GRANT ALL ON public.agent_registration_gate_overrides TO service_role;

ALTER TABLE public.agent_registration_gate_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agent reg overrides readable by agent and ops" ON public.agent_registration_gate_overrides;
CREATE POLICY "agent reg overrides readable by agent and ops"
ON public.agent_registration_gate_overrides
FOR SELECT TO authenticated
USING (
  agent_id = auth.uid()
  OR public.is_ops_role(auth.uid())
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'cfo')
);

COMMENT ON TABLE public.agent_registration_gate_overrides IS
  'Audit trail of management overrides of the agent registration restriction: who approved, when, agent, reason, previous state and override state.';

-- ---------------------------------------------------------------- rules
CREATE OR REPLACE FUNCTION public.agent_registration_gate_rules()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_defaults jsonb := jsonb_build_object(
    'min_active_tenants', 20,
    'required_prev_month_pct', 80
  );
  v_stored jsonb;
BEGIN
  SELECT value INTO v_stored FROM public.system_config WHERE key = 'agent_registration_gate_rules';
  IF v_stored IS NULL OR jsonb_typeof(v_stored) <> 'object' THEN
    RETURN v_defaults;
  END IF;
  RETURN v_defaults || v_stored;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_agent_registration_gate_rules(p_rules jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_min int;
  v_pct numeric;
BEGIN
  IF NOT (
    has_role(auth.uid(), 'manager') OR has_role(auth.uid(), 'super_admin')
    OR has_role(auth.uid(), 'ceo') OR has_role(auth.uid(), 'coo')
    OR has_role(auth.uid(), 'cfo')
  ) THEN
    RAISE EXCEPTION 'Only management can change the registration control rules';
  END IF;

  v_min := COALESCE((p_rules->>'min_active_tenants')::int, 20);
  v_pct := COALESCE((p_rules->>'required_prev_month_pct')::numeric, 80);
  IF v_min < 1 THEN RAISE EXCEPTION 'Active tenant threshold must be at least 1'; END IF;
  IF v_pct < 0 OR v_pct > 100 THEN RAISE EXCEPTION 'Required performance must be between 0 and 100'; END IF;

  INSERT INTO public.system_config (key, value)
  VALUES ('agent_registration_gate_rules',
          jsonb_build_object('min_active_tenants', v_min, 'required_prev_month_pct', v_pct))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  RETURN public.agent_registration_gate_rules();
END;
$$;

-- -------------------------------------------------------------- metrics
-- Previous calendar month (Africa/Kampala). Expected comes from the pinned
-- day plans when the window is pinned, otherwise from the same plan schedule
-- view the daily collection target uses. Collected comes from the existing
-- authoritative agent_ops_report_collected.
CREATE OR REPLACE FUNCTION public.agent_registration_gate_metrics(p_agent_ids uuid[])
RETURNS TABLE(
  agent_id uuid,
  active_tenants int,
  prev_expected numeric,
  prev_collected numeric,
  prev_pct numeric,
  basis text,
  period_start date,
  period_end date
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ws date := (date_trunc('month', (now() AT TIME ZONE 'Africa/Kampala')::date) - interval '1 month')::date;
  v_we date := (date_trunc('month', (now() AT TIME ZONE 'Africa/Kampala')::date) - interval '1 day')::date;
  v_pinned boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.agent_expected_day_plans p WHERE p.day BETWEEN v_ws AND v_we
  ) INTO v_pinned;

  RETURN QUERY
  WITH ids AS (
    SELECT DISTINCT u AS agent_id FROM unnest(p_agent_ids) AS u WHERE u IS NOT NULL
  ),
  pinned_expected AS (
    SELECT p.agent_id, COALESCE(SUM(p.expected_ugx), 0)::numeric AS expected
    FROM public.agent_expected_day_plans p
    WHERE p.day BETWEEN v_ws AND v_we AND p.agent_id IS NOT NULL
    GROUP BY p.agent_id
  ),
  derived_expected AS (
    SELECT s.agent_id,
           COALESCE(SUM(
             GREATEST(0,
               LEAST(s.daily_amount * GREATEST(LEAST(v_we, s.obligation_end) - s.term_start + 1, 0), s.total_amount)
               - LEAST(s.daily_amount * GREATEST(GREATEST(v_ws, s.term_start) - s.term_start, 0), s.total_amount)
             )
           ), 0)::numeric AS expected
    FROM public.v_rent_plan_schedule s
    WHERE s.agent_id IS NOT NULL
      AND s.term_start <= v_we
      AND s.obligation_end >= v_ws
    GROUP BY s.agent_id
  ),
  collected AS (
    SELECT c.agent_id, c.collected
    FROM public.agent_ops_report_collected(v_ws, v_we) c
  )
  SELECT i.agent_id,
         COALESCE(e.active_count, 0)::int,
         COALESCE(exp.expected, 0)::numeric,
         COALESCE(c.collected, 0)::numeric,
         CASE WHEN COALESCE(exp.expected, 0) > 0
              THEN LEAST(100, ROUND(COALESCE(c.collected, 0) / exp.expected * 100, 1))
              ELSE NULL END,
         CASE WHEN v_pinned THEN 'pinned_day_plans' ELSE 'plan_schedule' END,
         v_ws,
         v_we
  FROM ids i
  LEFT JOIN public.v_agent_daily_eligibility e ON e.agent_id = i.agent_id
  LEFT JOIN LATERAL (
    SELECT CASE WHEN v_pinned
                THEN (SELECT pe.expected FROM pinned_expected pe WHERE pe.agent_id = i.agent_id)
                ELSE (SELECT de.expected FROM derived_expected de WHERE de.agent_id = i.agent_id)
           END AS expected
  ) exp ON true
  LEFT JOIN collected c ON c.agent_id = i.agent_id;
END;
$$;

-- --------------------------------------------------------------- status
CREATE OR REPLACE FUNCTION public.agent_registration_gate_status(p_agent_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_agent uuid := COALESCE(p_agent_id, auth.uid());
  v_rules jsonb := public.agent_registration_gate_rules();
  v_min int;
  v_req numeric;
  v_m record;
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

  v_min := (v_rules->>'min_active_tenants')::int;
  v_req := (v_rules->>'required_prev_month_pct')::numeric;

  SELECT * INTO v_m FROM public.agent_registration_gate_metrics(ARRAY[v_agent]) LIMIT 1;

  SELECT * INTO v_ov
  FROM public.agent_registration_gate_overrides o
  WHERE o.agent_id = v_agent
    AND o.active
    AND (o.expires_at IS NULL OR o.expires_at > now())
  ORDER BY o.created_at DESC
  LIMIT 1;

  IF COALESCE(v_m.active_tenants, 0) >= v_min
     AND v_m.prev_pct IS NOT NULL
     AND v_m.prev_pct < v_req THEN
    v_blocked := true;
    v_reason := format(
      'Registration is restricted. You have %s active tenants (the limit is %s) and your %s collection performance was %s%%, below the required %s%%. Collect more from the tenants you already have to lift the restriction.',
      v_m.active_tenants, v_min, to_char(v_m.period_start, 'FMMonth YYYY'),
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

-- ------------------------------------------------------------- override
CREATE OR REPLACE FUNCTION public.grant_agent_registration_override(
  p_agent_id uuid,
  p_reason text,
  p_days int DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_prev jsonb;
  v_id uuid;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR has_role(auth.uid(), 'manager') OR has_role(auth.uid(), 'super_admin')
    OR has_role(auth.uid(), 'ceo') OR has_role(auth.uid(), 'coo')
    OR has_role(auth.uid(), 'cfo')
  ) THEN
    RAISE EXCEPTION 'Only management can override the registration restriction';
  END IF;
  IF char_length(btrim(COALESCE(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'Give a reason of at least 10 characters for this override';
  END IF;

  v_prev := public.agent_registration_gate_status(p_agent_id);

  UPDATE public.agent_registration_gate_overrides
  SET active = false, revoked_at = now(), revoked_by = auth.uid(),
      revoke_reason = 'Superseded by a newer override'
  WHERE agent_id = p_agent_id AND active;

  INSERT INTO public.agent_registration_gate_overrides (
    agent_id, approved_by, reason, previous_state, new_state, expires_at
  ) VALUES (
    p_agent_id, auth.uid(), btrim(p_reason),
    jsonb_build_object(
      'restricted', v_prev->'restricted',
      'blocked', v_prev->'blocked',
      'active_tenants', v_prev->'active_tenants',
      'prev_month_pct', v_prev->'prev_month_pct',
      'required_prev_month_pct', v_prev->'required_prev_month_pct'
    ),
    jsonb_build_object('blocked', false, 'override', 'granted',
                       'valid_days', GREATEST(COALESCE(p_days, 30), 1)),
    now() + (GREATEST(COALESCE(p_days, 30), 1) || ' days')::interval
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('override_id', v_id, 'status', public.agent_registration_gate_status(p_agent_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_agent_registration_override(
  p_override_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_agent uuid;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR has_role(auth.uid(), 'manager') OR has_role(auth.uid(), 'super_admin')
    OR has_role(auth.uid(), 'ceo') OR has_role(auth.uid(), 'coo')
    OR has_role(auth.uid(), 'cfo')
  ) THEN
    RAISE EXCEPTION 'Only management can withdraw an override';
  END IF;
  IF char_length(btrim(COALESCE(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'Give a reason of at least 10 characters for withdrawing this override';
  END IF;

  UPDATE public.agent_registration_gate_overrides
  SET active = false, revoked_at = now(), revoked_by = auth.uid(), revoke_reason = btrim(p_reason)
  WHERE id = p_override_id AND active
  RETURNING agent_id INTO v_agent;

  IF v_agent IS NULL THEN
    RAISE EXCEPTION 'That override is no longer active';
  END IF;

  RETURN public.agent_registration_gate_status(v_agent);
END;
$$;

-- --------------------------------------------------------- control list
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

  CREATE TEMP TABLE IF NOT EXISTS tmp_arc (
    agent_id uuid, full_name text, phone text,
    active_tenants int, prev_expected numeric, prev_collected numeric, prev_pct numeric,
    basis text, period_start date, period_end date,
    restricted boolean, blocked boolean,
    override_id uuid, override_reason text, override_by text, override_at timestamptz, override_expires timestamptz
  ) ON COMMIT DROP;
  DELETE FROM tmp_arc;

  INSERT INTO tmp_arc
  SELECT m.agent_id,
         pr.full_name,
         pr.phone,
         m.active_tenants, m.prev_expected, m.prev_collected, m.prev_pct,
         m.basis, m.period_start, m.period_end,
         (m.active_tenants >= v_min AND m.prev_pct IS NOT NULL AND m.prev_pct < v_req) AS restricted,
         (m.active_tenants >= v_min AND m.prev_pct IS NOT NULL AND m.prev_pct < v_req AND o.id IS NULL) AS blocked,
         o.id, o.reason, ap.full_name, o.created_at, o.expires_at
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
  LEFT JOIN public.profiles ap ON ap.id = o.approved_by;

  SELECT jsonb_build_object(
    'agents', count(*),
    'at_threshold', count(*) FILTER (WHERE active_tenants >= v_min),
    'restricted', count(*) FILTER (WHERE restricted),
    'blocked', count(*) FILTER (WHERE blocked),
    'overridden', count(*) FILTER (WHERE restricted AND override_id IS NOT NULL)
  ) INTO v_totals FROM tmp_arc;

  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.blocked DESC, t.restricted DESC, t.active_tenants DESC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT * FROM tmp_arc
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
  ) t;

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

REVOKE ALL ON FUNCTION public.agent_registration_gate_metrics(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_registration_gate_metrics(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_registration_gate_rules() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agent_registration_gate_status(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_agent_registration_gate_rules(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.grant_agent_registration_override(uuid, text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_agent_registration_override(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_agent_registration_control(text, text, int, int) TO authenticated;
