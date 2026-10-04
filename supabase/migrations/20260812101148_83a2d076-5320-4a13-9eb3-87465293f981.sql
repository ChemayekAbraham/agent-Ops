CREATE OR REPLACE FUNCTION public.claim_withdrawal_verified(p_withdrawal_id uuid, p_momo_number text DEFAULT NULL::text, p_momo_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent_id uuid;
  v_w withdrawal_requests%ROWTYPE;
  v_is_momo boolean;
  v_stored_num text;
  v_in_num text;
  v_stored_name text;
  v_in_name text;
BEGIN
  -- Caller must be an active cash-out (merchant) agent.
  SELECT id INTO v_agent_id
  FROM cashout_agents
  WHERE agent_id = auth.uid() AND is_active = true
  LIMIT 1;

  IF v_agent_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_cashout_agent',
      'message', 'You are not an active cash-out agent.');
  END IF;

  -- Lock the row so the verification and the claim are atomic.
  SELECT * INTO v_w FROM withdrawal_requests WHERE id = p_withdrawal_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found',
      'message', 'Withdrawal not found.');
  END IF;

  -- NOTE (2026-08-12): the legacy guard compared the payout against the merchant's
  -- own wallets.float_balance. That is obsolete under the shared payout float
  -- architecture (get_merchant_payout_float) and the out-of-pocket receivable model
  -- (merchant_out_of_pocket_advances), where a shortfall is recorded as a
  -- reimbursable advance at settlement time rather than blocked at claim time.
  -- Claim-time float blocking is therefore removed.

  v_is_momo := COALESCE(v_w.payout_method, '') IN
    ('mobile_money', 'mtn_mobile_money', 'airtel_money');

  IF v_is_momo THEN
    v_stored_num := regexp_replace(COALESCE(v_w.mobile_money_number, ''), '\D', '', 'g');
    v_in_num     := regexp_replace(COALESCE(p_momo_number, ''), '\D', '', 'g');
    IF length(v_stored_num) >= 9 THEN v_stored_num := right(v_stored_num, 9); END IF;
    IF length(v_in_num) >= 9 THEN v_in_num := right(v_in_num, 9); END IF;

    IF v_stored_num = '' THEN
      RETURN jsonb_build_object('error', 'no_stored_number',
        'message', 'This withdrawal has no stored Mobile Money number to verify against.');
    END IF;

    IF v_in_num IS NULL OR v_in_num = '' OR v_in_num <> v_stored_num THEN
      RETURN jsonb_build_object('error', 'number_mismatch',
        'message', 'The Mobile Money number being claimed does not match the stored payout number.');
    END IF;

    v_stored_name := COALESCE(v_w.mobile_money_name, '');
    IF v_stored_name <> '' THEN
      v_in_name := btrim(regexp_replace(
        regexp_replace(lower(COALESCE(p_momo_name, '')), '[^a-z0-9 ]', '', 'g'),
        '\s+', ' ', 'g'));
      v_stored_name := btrim(regexp_replace(
        regexp_replace(lower(v_stored_name), '[^a-z0-9 ]', '', 'g'),
        '\s+', ' ', 'g'));

      IF v_in_name = '' OR v_in_name <> v_stored_name THEN
        RETURN jsonb_build_object('error', 'name_mismatch',
          'message', 'The registered Mobile Money name being claimed does not match the stored payout name.');
      END IF;
    END IF;
  END IF;

  -- Race-guarded claim: only succeeds if still unclaimed.
  UPDATE withdrawal_requests
  SET assigned_cashout_agent_id = v_agent_id,
      dispatched_at = now()
  WHERE id = p_withdrawal_id
    AND assigned_cashout_agent_id IS NULL;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'already_claimed',
      'message', 'Already claimed by another agent — refreshing queue.');
  END IF;

  RETURN jsonb_build_object('success', true, 'withdrawal_id', p_withdrawal_id);
END;
$function$;