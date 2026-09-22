-- Agent Registration Control: the out-of-the-box default is NO barrier.
-- Unconfigured rules now mean the restriction is switched off and the required
-- previous-month percentage is 0, so no agent is ever stopped until ops choose
-- a percentage themselves. No change to tenant-registration or performance logic.

CREATE OR REPLACE FUNCTION public.agent_registration_gate_rules()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_defaults jsonb := jsonb_build_object(
    'enabled', false,
    'min_active_tenants', 0,
    'required_prev_month_pct', 0,
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
      'min_active_tenants', COALESCE((v_out->>'min_active_tenants')::int, 0),
      'max_active_tenants', NULL,
      'required_prev_month_pct', COALESCE((v_out->>'required_prev_month_pct')::numeric, 0),
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

  v_enabled := COALESCE((p_rules->>'enabled')::boolean, false);

  IF jsonb_typeof(p_rules->'groups') = 'array' THEN
    FOR v_g IN SELECT * FROM jsonb_array_elements(p_rules->'groups') LOOP
      v_i := v_i + 1;
      v_min := COALESCE((v_g->>'min_active_tenants')::int, 0);
      v_max := NULLIF(v_g->>'max_active_tenants', '')::int;
      v_pct := COALESCE((v_g->>'required_prev_month_pct')::numeric, 0);

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
    v_min := COALESCE((p_rules->>'min_active_tenants')::int, 0);
    v_pct := COALESCE((p_rules->>'required_prev_month_pct')::numeric, 0);
    IF v_min < 0 THEN RAISE EXCEPTION 'The tenant count cannot be negative'; END IF;
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