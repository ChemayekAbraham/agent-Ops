
CREATE OR REPLACE FUNCTION public.release_stale_cashout_claims()
RETURNS TABLE(released_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ids uuid[];
  v_count integer;
BEGIN
  -- Only release claims that show ZERO settlement progress. If the merchant has
  -- uploaded proof, pasted a payout code / transaction id, or has an in-flight
  -- processing marker, DO NOT return the row to the pool — a second merchant
  -- would otherwise pay the same tenant again ("duplicate reappearing"). The
  -- window is 45 minutes to accommodate real MoMo delays.
  WITH released AS (
    UPDATE public.withdrawal_requests
       SET assigned_cashout_agent_id = NULL,
           dispatched_at = NULL
     WHERE assigned_cashout_agent_id IS NOT NULL
       AND dispatched_at IS NOT NULL
       AND dispatched_at < (now() - interval '45 minutes')
       AND status IN ('pending', 'requested', 'manager_approved', 'cfo_approved', 'approved', 'fin_ops_approved')
       AND processing_started_at IS NULL
       AND COALESCE(payout_proof, '') = ''
       AND COALESCE(payout_code, '') = ''
       AND COALESCE(transaction_id, '') = ''
    RETURNING id
  )
  SELECT array_agg(id), count(*) INTO v_ids, v_count FROM released;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
    VALUES (
      NULL,
      'cashout_claim_auto_released',
      'withdrawal_requests',
      'cashout_claims',
      jsonb_build_object(
        'released_count', COALESCE(v_count, 0),
        'released_ids', COALESCE(v_ids, ARRAY[]::uuid[]),
        'released_at', now(),
        'window_minutes', 45,
        'reason', 'claim exceeded 45 minute payout window with zero settlement progress'
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN QUERY SELECT COALESCE(v_count, 0);
END;
$function$;
