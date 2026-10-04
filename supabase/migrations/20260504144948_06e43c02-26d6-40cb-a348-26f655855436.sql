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
       AND dispatched_at < (now() - interval '15 minutes')
       AND status IN ('pending', 'requested', 'manager_approved', 'cfo_approved', 'approved', 'fin_ops_approved')
    RETURNING id, assigned_cashout_agent_id
  )
  SELECT count(*) INTO v_count FROM released;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
    VALUES (
      NULL,
      'cashout_claim_auto_released',
      'withdrawal_requests',
      'cashout_claims',
      jsonb_build_object(
        'released_count', v_count,
        'released_at', now(),
        'reason', 'claim exceeded 15 minute payout window'
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN QUERY SELECT v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.release_stale_cashout_claims() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_stale_cashout_claims() TO service_role, authenticated;

DROP POLICY IF EXISTS "Active merchant agents can claim or release payouts" ON public.withdrawal_requests;

CREATE POLICY "Active merchant agents can claim or release payouts"
ON public.withdrawal_requests
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.cashout_agents ca
    WHERE ca.agent_id = auth.uid()
      AND ca.is_active = true
  )
  AND status IN ('pending', 'requested', 'approved', 'manager_approved', 'cfo_approved', 'fin_ops_approved')
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.cashout_agents ca
    WHERE ca.agent_id = auth.uid()
      AND ca.is_active = true
  )
  AND (
    assigned_cashout_agent_id IS NULL
    OR assigned_cashout_agent_id IN (
      SELECT ca.id FROM public.cashout_agents ca
      WHERE ca.agent_id = auth.uid()
        AND ca.is_active = true
    )
  )
);

DROP POLICY IF EXISTS "Owners staff and active merchant agents can view withdrawals" ON public.withdrawal_requests;

CREATE POLICY "Owners staff and active merchant agents can view withdrawals"
ON public.withdrawal_requests
FOR SELECT
TO authenticated
USING (
  auth.uid() = user_id
  OR EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = auth.uid()
      AND user_roles.role IN ('manager', 'operations', 'cfo', 'coo', 'super_admin', 'cto')
  )
  OR (
    status IN ('pending', 'requested', 'approved', 'manager_approved', 'cfo_approved', 'fin_ops_approved')
    AND EXISTS (
      SELECT 1 FROM public.cashout_agents ca
      WHERE ca.agent_id = auth.uid()
        AND ca.is_active = true
    )
  )
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('release-stale-cashout-claims-every-5min');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;

    PERFORM cron.schedule(
      'release-stale-cashout-claims-every-5min',
      '*/5 * * * *',
      $job$SELECT public.release_stale_cashout_claims();$job$
    );
  END IF;
END $$;