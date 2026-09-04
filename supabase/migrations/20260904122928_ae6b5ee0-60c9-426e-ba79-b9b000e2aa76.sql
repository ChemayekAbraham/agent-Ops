DO $mig$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
   WHERE p.proname = 'settle_tenant_rent_from_deposit'
     AND p.pronamespace = 'public'::regnamespace;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'settle_tenant_rent_from_deposit not found';
  END IF;

  v_old := $old$  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = v_dep.user_id
       AND ur.role IN ('agent', 'senior_agent', 'sub_agent')
       AND COALESCE(ur.enabled, true)
  ) INTO v_is_agent_actor;$old$;

  v_new := $new$  -- An "operating agent" actually collects for other people or carries company
  -- float. Signup grants EVERY user the agent role, so a bare role grant must
  -- never stop a tenant from settling their own daily rent.
  SELECT EXISTS (
    SELECT 1 FROM public.rent_requests rr
     WHERE rr.agent_id = v_dep.user_id
       AND rr.status IN ('repaying', 'disbursed', 'funded')
  ) OR EXISTS (
    SELECT 1 FROM public.agent_collections ac
     WHERE ac.agent_id = v_dep.user_id
  ) OR EXISTS (
    SELECT 1 FROM public.agent_float_limits fl
     WHERE fl.agent_id = v_dep.user_id
  ) INTO v_is_agent_actor;$new$;

  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'expected role gate not found in settle_tenant_rent_from_deposit';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END
$mig$;