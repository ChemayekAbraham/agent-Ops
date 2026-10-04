-- Confirmed by two independent production data-failure audits on 2026-09-14:
-- release_stale_cashout_claims() (the 5-minute cron that returns a merchant's
-- claimed withdrawal to the pool after 45 minutes with zero settlement
-- progress) releases the WITHDRAWAL but never releases the merchant's
-- corresponding merchant_float_reservations row. This was already listed as
-- a known-unfixed gap in docs/HANDOVER/08-incident-2026-09-12-merchant-claim.md
-- ("Still broken #1") -- both audits independently found it is not dormant:
-- a real, live instance existed at the time of the audit.
--
-- Withdrawal 4551f812-8fb8-48c2-8640-8fa24da6eacb: claimed by an agent
-- 2026-09-13 14:14:57 UTC, silently returned to the pending pool by this cron
-- 45 minutes later, while its UGX 20,700 merchant_float_reservations row
-- (id 6aa77f2f-ba7a-42e6-bc6a-d77930351aae) sat in state = 'reserved' for
-- ~17 hours afterward with zero trace of a release -- understating that
-- agent's available float the whole time.
--
-- Fix: after releasing the withdrawal rows, call the existing (idempotent)
-- release_merchant_float(withdrawal_id, reason) for each one. It is a
-- documented no-op when no reservation exists and refuses (does not
-- silently corrupt) if the reservation was already consumed elsewhere, so
-- this is safe to call unconditionally for every id this function releases.
-- Errors from an individual release are caught and recorded in the
-- function's own audit_logs row rather than aborting the whole sweep.
--
-- One-time remediation applied directly against the live orphaned row
-- above (release_merchant_float called manually, verified state = 'released'
-- afterward) before this migration was written -- confirmed via a full
-- reserved-but-unassigned-withdrawal scan that it was the only one.

CREATE OR REPLACE FUNCTION public.release_stale_cashout_claims()
 RETURNS TABLE(released_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ids uuid[];
  v_count integer;
  v_id uuid;
  v_float_release_errors jsonb := '[]'::jsonb;
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

  IF v_ids IS NOT NULL THEN
    FOREACH v_id IN ARRAY v_ids LOOP
      BEGIN
        PERFORM public.release_merchant_float(v_id, 'stale_claim_auto_released');
      EXCEPTION WHEN OTHERS THEN
        v_float_release_errors := v_float_release_errors || jsonb_build_object('withdrawal_id', v_id, 'error', SQLERRM);
      END;
    END LOOP;
  END IF;

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
        'reason', 'claim exceeded 45 minute payout window with zero settlement progress',
        'float_release_errors', v_float_release_errors
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN QUERY SELECT COALESCE(v_count, 0);
END;
$function$;
