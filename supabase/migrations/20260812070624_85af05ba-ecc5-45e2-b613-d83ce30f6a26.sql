CREATE OR REPLACE FUNCTION public.resolve_service_center_manager_for_agent(p_agent_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_manager uuid;
  v_current uuid;
  v_parent uuid;
  v_depth int := 0;
BEGIN
  IF p_agent_id IS NULL THEN RETURN NULL; END IF;

  -- Walk up the verified parent chain (max 3 hops); first related, active
  -- Service Centre manager wins. Being a manager yourself does NOT stop your
  -- own submissions from being vetted by your parent -- it only means you can
  -- never be your own vetter (guaranteed here because we start at the parent).
  v_current := p_agent_id;
  WHILE v_depth < 3 LOOP
    SELECT s.parent_agent_id INTO v_parent
    FROM public.agent_subagents s
    WHERE s.sub_agent_id = v_current
      AND s.status = 'verified'
      AND s.parent_agent_id <> v_current
    ORDER BY s.verified_at DESC NULLS LAST, s.created_at DESC
    LIMIT 1;

    IF v_parent IS NULL THEN EXIT; END IF;
    IF v_parent = p_agent_id THEN EXIT; END IF; -- cycle guard

    IF public.is_service_center_manager(v_parent) THEN
      v_manager := v_parent;
      EXIT;
    END IF;

    v_current := v_parent;
    v_depth := v_depth + 1;
  END LOOP;

  -- No related, active Service Centre manager -> NULL, so the submission goes
  -- straight to Agent Ops. Never hand work to an unrelated manager.
  RETURN v_manager;
END;
$$;