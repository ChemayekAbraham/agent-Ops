-- Activity snapshot used to decide whether an agent has done any real work.
CREATE OR REPLACE FUNCTION public.agent_advance_activity(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_subagents int := 0;
  v_rent_requests int := 0;
  v_collections int := 0;
  v_collected numeric := 0;
  v_promissory int := 0;
  v_houses int := 0;
BEGIN
  SELECT COUNT(*) INTO v_subagents
  FROM public.agent_subagents s
  WHERE s.parent_agent_id = p_user_id
    AND s.sub_agent_id IS NOT NULL
    AND (s.status IN ('active','verified') OR s.accepted_at IS NOT NULL);

  SELECT COUNT(*) INTO v_rent_requests
  FROM public.rent_requests rr
  WHERE rr.agent_id = p_user_id
    AND rr.tenant_id IS NOT NULL
    AND rr.agent_id <> rr.tenant_id;

  SELECT COUNT(*), COALESCE(SUM(amount), 0) INTO v_collections, v_collected
  FROM public.agent_collections WHERE agent_id = p_user_id;

  SELECT COUNT(*) INTO v_promissory
  FROM public.promissory_notes pn
  WHERE pn.agent_id = p_user_id
    AND (pn.status IN ('activated','approved') OR pn.approved_at IS NOT NULL);

  SELECT COUNT(*) INTO v_houses
  FROM public.house_listings hl
  WHERE hl.agent_id = p_user_id
    AND hl.verified_at IS NOT NULL
    AND COALESCE(hl.status, '') <> 'rejected';

  RETURN jsonb_build_object(
    'subagents', v_subagents,
    'rent_requests', v_rent_requests,
    'collections', v_collections,
    'collected_amount', v_collected,
    'promissory_notes', v_promissory,
    'verified_houses', v_houses,
    'signals', (CASE WHEN v_subagents > 0 THEN 1 ELSE 0 END)
             + (CASE WHEN v_rent_requests > 0 THEN 1 ELSE 0 END)
             + (CASE WHEN v_collections > 0 THEN 1 ELSE 0 END)
             + (CASE WHEN v_promissory > 0 THEN 1 ELSE 0 END)
             + (CASE WHEN v_houses > 0 THEN 1 ELSE 0 END),
    'eligible', (v_subagents > 0 OR v_rent_requests > 0 OR v_collections > 0
                 OR v_promissory > 0 OR v_houses > 0)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.agent_advance_activity(uuid) TO authenticated, service_role;

-- Hard gate: no activity, no advance request.
CREATE OR REPLACE FUNCTION public.enforce_agent_advance_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v jsonb;
BEGIN
  v := public.agent_advance_activity(NEW.agent_id);

  IF NOT (v->>'eligible')::boolean THEN
    RAISE EXCEPTION 'ADVANCE_NO_ACTIVITY: You have not recorded any agent work yet. Recruit a sub-agent, raise a rent request for a tenant, collect rent, activate a promissory note, or get a house you listed verified — then you can request an advance.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_enforce_agent_advance_activity ON public.agent_advance_requests;
CREATE TRIGGER zz_enforce_agent_advance_activity
BEFORE INSERT ON public.agent_advance_requests
FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_advance_activity();