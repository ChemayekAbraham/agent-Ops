-- 1) Team-membership helper: is p_agent inside p_manager's verified sub-agent tree?
CREATE OR REPLACE FUNCTION public.is_agent_in_service_center_team(p_manager_id uuid, p_agent_id uuid, p_max_depth int DEFAULT 3)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE tree AS (
    SELECT s.sub_agent_id, 1 AS depth
    FROM public.agent_subagents s
    WHERE s.parent_agent_id = p_manager_id
      AND s.status = 'verified'
      AND s.sub_agent_id <> p_manager_id
    UNION ALL
    SELECT s.sub_agent_id, t.depth + 1
    FROM public.agent_subagents s
    JOIN tree t ON s.parent_agent_id = t.sub_agent_id
    WHERE s.status = 'verified'
      AND t.depth < GREATEST(1, COALESCE(p_max_depth, 3))
      AND s.sub_agent_id <> p_manager_id
  )
  SELECT p_manager_id IS NOT NULL
     AND p_agent_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM tree WHERE sub_agent_id = p_agent_id);
$$;

GRANT EXECUTE ON FUNCTION public.is_agent_in_service_center_team(uuid, uuid, int) TO authenticated, service_role;

-- 2) Strict resolver: relationship only. No district / lightest-queue fallback.
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
  -- a service centre manager never vets their own submissions
  IF public.is_service_center_manager(p_agent_id) THEN RETURN NULL; END IF;

  -- walk up the verified parent chain (max 3 hops); first active manager wins
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

-- 3) One-time correction: release mis-routed items to Agent Ops.
UPDATE public.rent_requests rr
   SET status = 'pending',
       service_center_manager_id = NULL,
       service_center_comment = COALESCE(rr.service_center_comment || ' | ', '')
         || 'System correction: routed to an unrelated Service Centre manager; passed on to Agent Ops.',
       service_center_reviewed_at = now(),
       updated_at = now()
 WHERE rr.status = 'service_center_review'
   AND rr.service_center_manager_id IS NOT NULL
   AND NOT public.is_agent_in_service_center_team(
         rr.service_center_manager_id,
         COALESCE(rr.agent_id, rr.assigned_agent_id)
       );

UPDATE public.house_listings h
   SET service_center_status = 'not_required',
       service_center_manager_id = NULL,
       service_center_comment = COALESCE(h.service_center_comment || ' | ', '')
         || 'System correction: routed to an unrelated Service Centre manager; passed on to Agent Ops.',
       service_center_reviewed_at = now(),
       updated_at = now()
 WHERE h.service_center_status = 'pending'
   AND h.service_center_manager_id IS NOT NULL
   AND NOT public.is_agent_in_service_center_team(h.service_center_manager_id, h.agent_id);