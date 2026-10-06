-- Wallet transfer reversal status: include the reversal date/time on the
-- 'reversed' state so the statement can show WHEN a transfer was taken back.
-- Backward compatible: `state`, `can_reverse`, `reason`, `sent`, `reversible`,
-- `recipient_id` are unchanged. New field on 'reversed' only:
--   reversed_at  — creation time of the reversal's ledger legs (timestamptz,
--                  serialized by to_jsonb as ISO 8601).
-- Reversal time is read from the idempotent reversal ledger rows
-- (idempotency_key = 'reversal:' || reference), the same signal the function
-- already uses to detect that a transfer was reversed — no new table needed.

CREATE OR REPLACE FUNCTION public.wallet_transfer_reversal_status(p_reference text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_out record;
  v_in record;
  v_avail numeric;
  v_amount numeric;
  v_is_sender boolean;
  v_is_recipient boolean;
  v_reversed_at timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('state', 'sign_in', 'can_reverse', false, 'reason', 'Please sign in.');
  END IF;

  SELECT * INTO v_out FROM general_ledger
   WHERE reference_id = p_reference AND category = 'wallet_transfer'
     AND direction = 'cash_out' AND ledger_scope = 'wallet'
   ORDER BY created_at LIMIT 1;
  SELECT * INTO v_in FROM general_ledger
   WHERE reference_id = p_reference AND category = 'wallet_transfer'
     AND direction = 'cash_in' AND ledger_scope = 'wallet'
   ORDER BY created_at LIMIT 1;

  IF v_out.id IS NULL OR v_in.id IS NULL THEN
    RETURN jsonb_build_object('state', 'not_found', 'can_reverse', false, 'reason', 'Transfer not found.');
  END IF;

  v_is_sender := v_out.user_id = v_uid;
  v_is_recipient := v_in.user_id = v_uid;

  IF NOT (v_is_sender OR v_is_recipient) THEN
    RETURN jsonb_build_object('state', 'not_involved', 'can_reverse', false, 'reason', 'Only the sender can reverse this transfer.');
  END IF;

  -- Both parties can see that a transfer was reversed (and when).
  SELECT max(created_at) INTO v_reversed_at
    FROM general_ledger
   WHERE idempotency_key = 'reversal:' || p_reference;
  IF v_reversed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'state', 'reversed',
      'can_reverse', false,
      'reason', 'This transfer has already been reversed.',
      'reversed_at', to_jsonb(v_reversed_at)
    );
  END IF;

  IF v_is_recipient THEN
    RETURN jsonb_build_object('state', 'received', 'can_reverse', false, 'reason', 'Only the sender can reverse this transfer.');
  END IF;

  IF EXISTS (
    SELECT 1 FROM withdrawal_requests w
     WHERE w.user_id = v_in.user_id
       AND w.created_at >= v_in.created_at
       AND coalesce(w.status,'') NOT IN ('rejected','cancelled','failed')
  ) THEN
    RETURN jsonb_build_object('state', 'withdrawn', 'can_reverse', false, 'reason', 'The recipient has already withdrawn, so this transfer can no longer be reversed.');
  END IF;

  v_avail := coalesce(public.get_user_available_balance(v_in.user_id), 0);
  v_amount := floor(least(v_in.amount, greatest(v_avail, 0)));

  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('state', 'nothing_left', 'can_reverse', false, 'reason', 'The recipient has no money left in their wallet to return.');
  END IF;

  RETURN jsonb_build_object(
    'state', 'reversible',
    'can_reverse', true,
    'sent', v_in.amount,
    'reversible', v_amount,
    'recipient_id', v_in.user_id
  );
END;
$function$;
