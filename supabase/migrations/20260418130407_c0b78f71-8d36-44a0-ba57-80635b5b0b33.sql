
-- Function: release stale cash-out claims (>10 minutes without completion)
CREATE OR REPLACE FUNCTION public.release_stale_cashout_claims()
RETURNS TABLE(released_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH released AS (
    UPDATE public.withdrawal_requests
       SET assigned_cashout_agent_id = NULL,
           dispatched_at = NULL
     WHERE assigned_cashout_agent_id IS NOT NULL
       AND dispatched_at IS NOT NULL
       AND dispatched_at < (now() - interval '10 minutes')
       AND status IN ('pending', 'requested', 'manager_approved', 'cfo_approved', 'fin_ops_approved')
    RETURNING id, assigned_cashout_agent_id
  )
  SELECT count(*) INTO v_count FROM released;

  -- Audit each release (best-effort, no failure)
  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, metadata)
    VALUES (NULL, 'cashout_claim_auto_released', 'withdrawal_requests',
            jsonb_build_object('released_count', v_count, 'released_at', now(), 'reason', 'claim exceeded 10 minute payout window'));
  EXCEPTION WHEN OTHERS THEN
    -- swallow audit errors so the release still happens
    NULL;
  END;

  RETURN QUERY SELECT v_count;
END;
$$;

-- Lock down execution
REVOKE ALL ON FUNCTION public.release_stale_cashout_claims() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_stale_cashout_claims() TO service_role, authenticated;
