CREATE OR REPLACE FUNCTION public._test_proxy_capability_sync()
RETURNS TABLE(test_name text, passed boolean, detail text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _agent uuid;
  _benef uuid;
  _benef2 uuid;
  _aid uuid;
  _aid2 uuid;
  _count int;
BEGIN
  -- Authorization: only privileged callers may invoke this test harness.
  IF NOT (
    public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'cto'::app_role)
    OR auth.role() = 'service_role'
  ) THEN
    RAISE EXCEPTION 'permission denied: _test_proxy_capability_sync requires staff role';
  END IF;

  -- Pick a clean-slate agent
  SELECT ur.user_id INTO _agent
  FROM public.user_roles ur
  WHERE ur.role = 'agent' AND ur.enabled = true
    AND NOT EXISTS (
      SELECT 1 FROM public.proxy_agent_assignments paa
      WHERE paa.agent_id = ur.user_id
        AND paa.is_active = true
        AND paa.approval_status = 'approved'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.agent_capabilities ac
      WHERE ac.agent_id = ur.user_id
        AND ac.capability IN ('act_as_proxy','capture_supporters')
        AND ac.status = 'active'
    )
  LIMIT 1;

  IF _agent IS NULL THEN
    RETURN QUERY SELECT 'setup'::text, false, 'no clean-slate agent available'::text;
    RETURN;
  END IF;

  SELECT id INTO _benef FROM public.profiles WHERE id <> _agent ORDER BY created_at DESC LIMIT 1;
  SELECT id INTO _benef2 FROM public.profiles
    WHERE id NOT IN (_agent, COALESCE(_benef, _agent))
    ORDER BY created_at DESC LIMIT 1;

  -- Run inside a savepoint so all writes roll back at the end.
  BEGIN
    -- T1: clean slate
    SELECT count(*) INTO _count FROM public.agent_capabilities
      WHERE agent_id = _agent
        AND capability IN ('act_as_proxy','capture_supporters')
        AND status = 'active';
    RETURN QUERY SELECT 'T1_clean_slate'::text, _count = 0,
      format('expected 0 active proxy caps, got %s', _count);

    -- T2: pending+inactive grants nothing
    INSERT INTO public.proxy_agent_assignments
      (agent_id, beneficiary_id, beneficiary_role, assigned_by, reason, is_active, approval_status)
    VALUES (_agent, _benef, 'supporter', _agent, 'test pending', false, 'pending')
    RETURNING id INTO _aid;
    SELECT count(*) INTO _count FROM public.agent_capabilities
      WHERE agent_id = _agent
        AND capability IN ('act_as_proxy','capture_supporters')
        AND status = 'active';
    RETURN QUERY SELECT 'T2_pending_inactive_no_caps'::text, _count = 0,
      format('expected 0 active caps, got %s', _count);

    -- T3: approve+activate → both caps
    UPDATE public.proxy_agent_assignments
       SET is_active = true, approval_status = 'approved' WHERE id = _aid;
    SELECT count(*) INTO _count FROM public.agent_capabilities
      WHERE agent_id = _agent
        AND capability IN ('act_as_proxy','capture_supporters')
        AND status = 'active';
    RETURN QUERY SELECT 'T3_approve_activate_grants_both'::text, _count = 2,
      format('expected 2 active caps, got %s', _count);

    -- T4: second active+approved — caps stable, no duplicates
    IF _benef2 IS NOT NULL THEN
      INSERT INTO public.proxy_agent_assignments
        (agent_id, beneficiary_id, beneficiary_role, assigned_by, reason, is_active, approval_status)
      VALUES (_agent, _benef2, 'supporter', _agent, 'test second', true, 'approved')
      RETURNING id INTO _aid2;
      SELECT count(*) INTO _count FROM public.agent_capabilities
        WHERE agent_id = _agent
          AND capability IN ('act_as_proxy','capture_supporters')
          AND status = 'active';
      RETURN QUERY SELECT 'T4_second_assignment_no_dupes'::text, _count = 2,
        format('expected 2 active caps, got %s', _count);

      -- T5: deactivate one of two → caps remain
      UPDATE public.proxy_agent_assignments SET is_active = false WHERE id = _aid2;
      SELECT count(*) INTO _count FROM public.agent_capabilities
        WHERE agent_id = _agent
          AND capability IN ('act_as_proxy','capture_supporters')
          AND status = 'active';
      RETURN QUERY SELECT 'T5_deactivate_one_keeps_caps'::text, _count = 2,
        format('expected 2 active caps, got %s', _count);
    END IF;

    -- T6: deactivate last active → caps revoked
    UPDATE public.proxy_agent_assignments SET is_active = false WHERE id = _aid;
    SELECT count(*) INTO _count FROM public.agent_capabilities
      WHERE agent_id = _agent
        AND capability IN ('act_as_proxy','capture_supporters')
        AND status = 'active';
    RETURN QUERY SELECT 'T6_deactivate_last_revokes'::text, _count = 0,
      format('expected 0 active caps, got %s', _count);

    -- T7: re-activate → both caps re-granted
    UPDATE public.proxy_agent_assignments
       SET is_active = true, approval_status = 'approved' WHERE id = _aid;
    SELECT count(*) INTO _count FROM public.agent_capabilities
      WHERE agent_id = _agent
        AND capability IN ('act_as_proxy','capture_supporters')
        AND status = 'active';
    RETURN QUERY SELECT 'T7_reactivation_regrants'::text, _count = 2,
      format('expected 2 active caps, got %s', _count);

    -- T8: approval flipped to rejected → caps revoked
    UPDATE public.proxy_agent_assignments
       SET approval_status = 'rejected' WHERE id = _aid;
    SELECT count(*) INTO _count FROM public.agent_capabilities
      WHERE agent_id = _agent
        AND capability IN ('act_as_proxy','capture_supporters')
        AND status = 'active';
    RETURN QUERY SELECT 'T8_rejected_status_revokes'::text, _count = 0,
      format('expected 0 active caps, got %s', _count);

    -- T9: re-approve, then DELETE → caps revoked
    UPDATE public.proxy_agent_assignments
       SET is_active = true, approval_status = 'approved' WHERE id = _aid;
    DELETE FROM public.proxy_agent_assignments WHERE id = _aid;
    IF _aid2 IS NOT NULL THEN
      DELETE FROM public.proxy_agent_assignments WHERE id = _aid2;
    END IF;
    SELECT count(*) INTO _count FROM public.agent_capabilities
      WHERE agent_id = _agent
        AND capability IN ('act_as_proxy','capture_supporters')
        AND status = 'active';
    RETURN QUERY SELECT 'T9_delete_revokes'::text, _count = 0,
      format('expected 0 active caps, got %s', _count);

    -- T10: default kit excludes capture_supporters
    RETURN QUERY SELECT 'T10_default_kit_excludes_capture_supporters'::text,
      NOT EXISTS (
        SELECT 1 FROM pg_proc
        WHERE proname = 'grant_default_agent_capabilities'
          AND prosrc LIKE '%capture_supporters%'
      ),
      'inspect grant_default_agent_capabilities source'::text;

    -- T11: default kit excludes act_as_proxy
    RETURN QUERY SELECT 'T11_default_kit_excludes_act_as_proxy'::text,
      NOT EXISTS (
        SELECT 1 FROM pg_proc
        WHERE proname = 'grant_default_agent_capabilities'
          AND prosrc LIKE '%act_as_proxy%'
      ),
      'inspect grant_default_agent_capabilities source'::text;

    -- T12: trigger installed
    RETURN QUERY SELECT 'T12_sync_trigger_installed'::text,
      EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_sync_proxy_agent_capabilities'
          AND tgrelid = 'public.proxy_agent_assignments'::regclass
      ),
      'pg_trigger lookup'::text;

    -- T13: unique constraint enforced
    RETURN QUERY SELECT 'T13_unique_constraint_present'::text,
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'agent_capabilities_agent_capability_uniq'
      ),
      'pg_constraint lookup'::text;

    -- Force rollback of all writes
    RAISE EXCEPTION 'TEST_ROLLBACK_OK';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM = 'TEST_ROLLBACK_OK' THEN
        -- expected: rolls back the savepoint cleanly
        NULL;
      ELSE
        RAISE;
      END IF;
  END;
END;
$$;

COMMENT ON FUNCTION public._test_proxy_capability_sync() IS
  'Internal test harness for sync_proxy_agent_capabilities + grant_default_agent_capabilities. Restricted to staff/service_role. Rolls back all writes via savepoint. Returns per-step pass/fail report.';

REVOKE ALL ON FUNCTION public._test_proxy_capability_sync() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._test_proxy_capability_sync() TO authenticated, service_role;