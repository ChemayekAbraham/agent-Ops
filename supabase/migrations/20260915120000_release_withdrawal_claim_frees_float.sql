-- Bug: Merchant Agents reported "release back to queue" as broken — after
-- releasing a claim, their NEXT claim attempt (or the same withdrawal being
-- reclaimed) behaved as if float was unavailable / already reserved.
--
-- Root cause, confirmed against WithdrawalPayoutCard.tsx's handleReject():
-- the manual "Release back to queue" button did a raw
-- `UPDATE withdrawal_requests SET assigned_cashout_agent_id = NULL, ...`
-- from the browser. It cleared the ASSIGNMENT but never released the
-- merchant's merchant_float_reservations row. This is exactly the same class
-- of bug already fixed for the 45-minute auto-release cron in
-- 20260914230000_fix_stale_claim_release_float_leak.sql, and is listed as
-- "Still broken #2" in docs/HANDOVER/08-incident-2026-09-12-merchant-claim.md
-- ("Manual 'Release back to queue' clears the assignment without releasing
-- float").
--
-- Effect on the merchant: their float stayed booked against a reservation
-- for a withdrawal they no longer held, understating what they had available
-- to claim with — and if another merchant claimed the same (now-unassigned)
-- withdrawal, claim_withdrawal_verified's orphan-handling would silently
-- steal the first merchant's reservation for the new claimant
-- ("orphan_released_then_reserved"), booking that payout against the WRONG
-- merchant's out-of-pocket cash the moment they touched it (Cause 5 of the
-- same incident).
--
-- Fix: a single canonical RPC, release_withdrawal_claim(), that does the
-- assignment clear AND the float release as one transaction, and is the only
-- sanctioned way for a merchant to hand a claim back to the queue (frontend
-- ledger-write guard: this replaces the frontend's direct table UPDATE).
-- Refuses to release a claim that already has settlement progress (proof /
-- payout code / TID / processing started) — releasing that back to the pool
-- risks a second merchant paying the same customer twice; the merchant must
-- finish or escalate to Financial Ops instead. Mirrors the same zero-progress
-- gate release_stale_cashout_claims() already applies.

CREATE OR REPLACE FUNCTION public.release_withdrawal_claim(
  p_withdrawal_id uuid,
  p_reason text DEFAULT 'manual'
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c_active CONSTANT text[] := ARRAY['pending', 'requested', 'manager_approved', 'cfo_approved', 'fin_ops_approved', 'approved'];
  v_uid uuid := auth.uid();
  v_desk uuid;
  v_w public.withdrawal_requests%ROWTYPE;
  v_release jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated',
      'message', 'Your session has expired. Sign in again.');
  END IF;

  SELECT id INTO v_desk FROM public.cashout_agents
  WHERE agent_id = v_uid AND is_active = true
  ORDER BY created_at, id LIMIT 1;

  IF v_desk IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_cashout_agent',
      'message', 'You are not an active Merchant Agent.');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('cashout_claim:' || v_desk::text));

  SELECT * INTO v_w FROM public.withdrawal_requests WHERE id = p_withdrawal_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found',
      'message', 'Withdrawal not found.');
  END IF;

  IF v_w.assigned_cashout_agent_id IS DISTINCT FROM v_desk THEN
    -- Already released (double tap) or never yours — idempotent, not an error.
    RETURN jsonb_build_object('success', true, 'idempotent', true, 'noop', true,
      'message', 'This payout is not currently claimed by you.');
  END IF;

  IF NOT (v_w.status = ANY (c_active)) OR v_w.processed_at IS NOT NULL
     OR COALESCE(v_w.fin_ops_reference, '') <> '' THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true, 'noop', true,
      'message', 'This payout is already closed.');
  END IF;

  IF v_w.processing_started_at IS NOT NULL
     OR COALESCE(v_w.payout_proof, '') <> ''
     OR COALESCE(v_w.payout_code, '') <> ''
     OR COALESCE(v_w.transaction_id, '') <> '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'settlement_in_progress',
      'message', 'You have already started paying this out (proof, TID or payout code recorded). Finish confirming it, or ask Financial Ops to intervene — releasing it now risks the customer being paid twice.');
  END IF;

  UPDATE public.withdrawal_requests
     SET assigned_cashout_agent_id = NULL,
         dispatched_at = NULL,
         dispatch_claimed_by = NULL,
         dispatch_claimed_at = NULL,
         dispatch_expires_at = NULL
   WHERE id = p_withdrawal_id;

  v_release := public.release_merchant_float(p_withdrawal_id, COALESCE(NULLIF(p_reason, ''), 'manual'));

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (
      v_uid, 'merchant_payout_released', 'withdrawal_requests', p_withdrawal_id,
      left(COALESCE(p_reason, 'manual'), 500),
      jsonb_build_object(
        'amount', v_w.amount,
        'payout_method', v_w.payout_method,
        'previous_status', v_w.status,
        'released_at', now(),
        'float_release', v_release
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL; -- audit trail must never block the release itself
  END;

  RETURN jsonb_build_object('success', true, 'idempotent', false, 'withdrawal_id', p_withdrawal_id,
    'float_release', v_release);
END;
$function$;

REVOKE ALL ON FUNCTION public.release_withdrawal_claim(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_withdrawal_claim(uuid, text) TO authenticated;
