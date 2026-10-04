CREATE OR REPLACE FUNCTION public.get_agent_smartphone_eligibility(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := COALESCE(p_user_id, auth.uid());
  v_rank integer;
  v_collected numeric;
  v_cap numeric;
  v_has_id boolean;
  v_has_workplace boolean;
  v_open integer;
  v_test_cap numeric;
  v_is_active_agent boolean;
  v_is_subagent boolean;
  v_active_tenants integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF v_uid <> auth.uid()
     AND NOT public.can_review_smartphone_orders(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT l.rank, l.collected INTO v_rank, v_collected
  FROM public.smartphone_leaderboard_ranks() l
  WHERE l.agent_id = v_uid;

  v_cap := public.smartphone_rank_cap(v_rank);

  -- Agent or linked sub-agent: flat UGX 1,000,000 ceiling.
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_uid
      AND ur.role IN ('agent','sub_agent')
      AND COALESCE(ur.enabled, true)
  ) OR EXISTS (
    SELECT 1 FROM public.agent_subagents s
    WHERE s.sub_agent_id = v_uid
      AND COALESCE(s.status,'') IN ('active','verified','approved')
  ) INTO v_is_active_agent;

  IF COALESCE(v_is_active_agent, false) THEN
    v_cap := GREATEST(COALESCE(v_cap, 0), 1000000);
  END IF;

  -- Testing allowlist: raises the cap only, never lowers an earned one.
  SELECT max_amount INTO v_test_cap
  FROM public.smartphone_test_allowlist
  WHERE user_id = v_uid AND active;

  IF v_test_cap IS NOT NULL THEN
    v_cap := GREATEST(COALESCE(v_cap, 0), v_test_cap);
    v_is_active_agent := true;
  END IF;

  -- Active tenants: funded/repaying rent requests assigned to this agent,
  -- to any of their sub-agents, or (for sub-agents) to their parent agent.
  SELECT count(DISTINCT rr.tenant_id) INTO v_active_tenants
  FROM public.rent_requests rr
  WHERE rr.status IN ('funded','repaying')
    AND COALESCE(rr.agent_id, rr.assigned_agent_id) IN (
      SELECT v_uid
      UNION
      SELECT s.sub_agent_id FROM public.agent_subagents s
        WHERE s.parent_agent_id = v_uid AND COALESCE(s.status,'') IN ('active','verified','approved')
      UNION
      SELECT s.parent_agent_id FROM public.agent_subagents s
        WHERE s.sub_agent_id = v_uid AND COALESCE(s.status,'') IN ('active','verified','approved')
    );

  SELECT COALESCE(NULLIF(btrim(COALESCE(national_id, '')), ''), '') <> ''
  INTO v_has_id FROM public.profiles WHERE id = v_uid;

  SELECT EXISTS (
    SELECT 1 FROM public.venue_visits
    WHERE user_id = v_uid AND category = 'workplace'
  ) INTO v_has_workplace;

  SELECT count(*) INTO v_open
  FROM public.merchandise_sales
  WHERE customer_id = v_uid
    AND lower(COALESCE(item_name, '')) LIKE '%phone%'
    AND COALESCE(order_status, 'submitted') IN ('pending_approval','submitted','ops_approved','coo_approved')
  ;

  RETURN jsonb_build_object(
    'user_id', v_uid,
    'rank', v_rank,
    'collected_30d', COALESCE(v_collected, 0),
    'max_amount', COALESCE(v_cap, 0),
    'test_access', v_test_cap IS NOT NULL,
    'active_tenant_count', COALESCE(v_active_tenants, 0),
    'required_active_tenants', 3,
    'has_national_id', COALESCE(v_has_id, false),
    'has_workplace_verification', COALESCE(v_has_workplace, false),
    'has_open_application', v_open > 0,
    'pickup_verification_complete', COALESCE(v_has_id, false) AND COALESCE(v_has_workplace, false),
    'eligible', COALESCE(v_is_active_agent, false)
                AND COALESCE(v_active_tenants, 0) >= 3
                AND v_open = 0
  );
END;
$function$;