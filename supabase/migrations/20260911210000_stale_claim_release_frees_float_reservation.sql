-- Defect C: stale claim release must free the merchant's float reservation too.
--
-- `release_stale_cashout_claims()` (cron `release-stale-cashout-claims`, every
-- 5 minutes) cleared the queue assignment after the 45-minute zero-progress
-- window but left the claim's `merchant_float_reservations` row `reserved`.
-- That understated the released merchant's available float for up to 48h, and
-- the next claimer inherited the stale reservation.
--
-- Shipped as its own migration rather than editing
-- 20260911200000_merchant_claim_reservation_ownership.sql, which is already
-- pushed and may already be applied — an edit there would never re-run.
-- CREATE OR REPLACE, so this is safe and idempotent in either order.
--
-- Cron name and schedule are unchanged. Function signature is unchanged.
-- ── 3. release_stale_cashout_claims ─────────────────────────────────────────
-- Changes vs live:
--   * Queue ownership and the claim's float reservation are released as ONE
--     unit per withdrawal: the unassign and the canonical
--     `release_merchant_float(withdrawal_id, 'stale_claim_auto_release')` run in
--     the same subtransaction, so either both happen or neither does (a failure
--     on one row rolls back only that row and is reported, the batch goes on).
--     Live released the assignment and left the reservation `reserved`.
--   * A claim whose reservation is already `consumed` (settlement recorded) is
--     preserved -- unassigning it would diverge queue state from float state.
--   * No reservation at all does not block releasing a genuinely stale claim.
--   * Reservation rows are never deleted; the released row keeps its history
--     with state 'released' and the reason above.
--   * Zero-evidence guard widened to every settlement marker: processing,
--     proof (URL or storage path), payout code, TID, processed_at, payment
--     reference, or a withdrawal_payment_evidence row. Threshold unchanged (45m).
--   * dispatch_claimed_by/_at are cleared with the assignment (a stale stamp
--     blocked accept_withdrawal_dispatch for every other merchant).
--   * Rows are taken FOR UPDATE SKIP LOCKED, so a withdrawal a merchant is
--     settling at this moment (row locked by approve-withdrawal) is never
--     released out from under them.
-- Signature (RETURNS TABLE(released_count integer)) and the
-- `release-stale-cashout-claims` cron schedule are unchanged.
CREATE OR REPLACE FUNCTION public.release_stale_cashout_claims()
 RETURNS TABLE(released_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_state text;
  v_rel jsonb;
  v_released uuid[] := ARRAY[]::uuid[];
  v_preserved uuid[] := ARRAY[]::uuid[];
  v_failed uuid[] := ARRAY[]::uuid[];
  v_resv integer := 0;
BEGIN
  -- Only release claims that show ZERO settlement progress. If the merchant has
  -- uploaded proof, pasted a payout code / transaction id, or has an in-flight
  -- processing marker, DO NOT return the row to the pool — a second merchant
  -- would otherwise pay the same tenant again ("duplicate reappearing"). The
  -- window is 45 minutes to accommodate real MoMo delays.
  FOR v_id IN
    SELECT w.id
      FROM public.withdrawal_requests w
     WHERE w.assigned_cashout_agent_id IS NOT NULL
       AND w.dispatched_at IS NOT NULL
       AND w.dispatched_at < (now() - interval '45 minutes')
       AND w.status IN ('pending', 'requested', 'manager_approved', 'cfo_approved', 'approved', 'fin_ops_approved')
       AND w.processing_started_at IS NULL
       AND w.processed_at IS NULL
       AND COALESCE(w.fin_ops_reference, '') = ''
       AND COALESCE(w.payout_proof, '') = ''
       AND COALESCE(w.payout_proof_path, '') = ''
       AND COALESCE(w.payout_code, '') = ''
       AND COALESCE(w.transaction_id, '') = ''
       AND NOT EXISTS (SELECT 1 FROM public.withdrawal_payment_evidence e
                        WHERE e.withdrawal_id = w.id)
     ORDER BY w.dispatched_at
     LIMIT 500
     FOR UPDATE OF w SKIP LOCKED
  LOOP
    SELECT r.state INTO v_state
      FROM public.merchant_float_reservations r
     WHERE r.withdrawal_id = v_id
     FOR UPDATE;

    IF v_state = 'consumed' THEN
      v_preserved := v_preserved || v_id;
      CONTINUE;
    END IF;

    BEGIN
      UPDATE public.withdrawal_requests
         SET assigned_cashout_agent_id = NULL,
             dispatched_at = NULL,
             dispatch_claimed_by = NULL,
             dispatch_claimed_at = NULL
       WHERE id = v_id;

      IF v_state = 'reserved' THEN
        v_rel := public.release_merchant_float(v_id, 'stale_claim_auto_release');
        IF COALESCE((v_rel->>'success')::boolean, false) IS NOT TRUE THEN
          RAISE EXCEPTION 'release_merchant_float refused for %: %', v_id, v_rel;
        END IF;
        v_resv := v_resv + 1;
      END IF;

      v_released := v_released || v_id;
    EXCEPTION WHEN OTHERS THEN
      -- The unassign above is rolled back with it: queue and float stay in step.
      v_failed := v_failed || v_id;
      RAISE WARNING 'release_stale_cashout_claims: kept claim % (%)', v_id, SQLERRM;
    END;
  END LOOP;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
    VALUES (
      NULL,
      'cashout_claim_auto_released',
      'withdrawal_requests',
      'cashout_claims',
      jsonb_build_object(
        'released_count', cardinality(v_released),
        'released_ids', to_jsonb(v_released),
        'reservations_released', v_resv,
        'preserved_consumed_ids', to_jsonb(v_preserved),
        'failed_ids', to_jsonb(v_failed),
        'released_at', now(),
        'window_minutes', 45,
        'reason', 'claim exceeded 45 minute payout window with zero settlement progress'
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN QUERY SELECT cardinality(v_released);
END;
$function$;
