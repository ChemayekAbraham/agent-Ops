CREATE OR REPLACE FUNCTION public.resolve_service_center_manager_for_agent(p_agent_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_manager uuid;
  v_district text;
BEGIN
  IF p_agent_id IS NULL THEN RETURN NULL; END IF;
  -- a service center manager never vets their own submissions
  IF public.is_service_center_manager(p_agent_id) THEN RETURN NULL; END IF;

  -- 1) the agent's own verified parent, when that parent is an active manager
  SELECT s.parent_agent_id INTO v_manager
  FROM public.agent_subagents s
  WHERE s.sub_agent_id = p_agent_id
    AND s.status = 'verified'
    AND s.parent_agent_id <> p_agent_id
    AND public.is_service_center_manager(s.parent_agent_id)
  ORDER BY s.verified_at DESC NULLS LAST, s.created_at DESC
  LIMIT 1;

  IF v_manager IS NOT NULL THEN RETURN v_manager; END IF;

  -- 2) an active manager in the same district as the agent
  SELECT p.district INTO v_district FROM public.profiles p WHERE p.id = p_agent_id;

  IF v_district IS NOT NULL AND btrim(v_district) <> '' THEN
    SELECT m.agent_id INTO v_manager
    FROM public.service_center_managers m
    JOIN public.profiles mp ON mp.id = m.agent_id
    WHERE m.status = 'active'
      AND m.agent_id <> p_agent_id
      AND lower(btrim(mp.district)) = lower(btrim(v_district))
    ORDER BY (
      SELECT count(*) FROM public.house_listings h
      WHERE h.service_center_manager_id = m.agent_id
        AND h.service_center_status = 'pending'
    ) ASC, m.tagged_at ASC NULLS LAST
    LIMIT 1;

    IF v_manager IS NOT NULL THEN RETURN v_manager; END IF;
  END IF;

  -- 3) fallback: the active manager with the lightest vetting queue
  SELECT m.agent_id INTO v_manager
  FROM public.service_center_managers m
  WHERE m.status = 'active'
    AND m.agent_id <> p_agent_id
  ORDER BY (
    SELECT count(*) FROM public.house_listings h
    WHERE h.service_center_manager_id = m.agent_id
      AND h.service_center_status = 'pending'
  ) ASC, m.tagged_at ASC NULLS LAST
  LIMIT 1;

  RETURN v_manager;
END; $function$;