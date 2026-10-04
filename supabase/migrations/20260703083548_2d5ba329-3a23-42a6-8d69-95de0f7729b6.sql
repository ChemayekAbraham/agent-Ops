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
  v_is_landlord_float boolean;
  v_float numeric;
  v_amount numeric;
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

  -- FRAUD GUARD: a merchant agent pays standard cash-outs from their own float
  -- bucket. They may only claim requests they can actually settle — i.e. the
  -- payout amount must not exceed their available float. Landlord-float payouts
  -- are exempt because the float was already deducted at disburse time and the
  -- merchant does not draw down their own float to settle them.
  v_is_landlord_float := (COALESCE(v_w.reason, '') LIKE 'Landlord float payout%');
  IF NOT v_is_landlord_float THEN
    v_amount := COALESCE(v_w.amount, 0);
    SELECT COALESCE(float_balance, 0) INTO v_float
    FROM wallets WHERE user_id = auth.uid();
    v_float := COALESCE(v_float, 0);

    IF v_amount > v_float THEN
      RETURN jsonb_build_object(
        'error', 'insufficient_float',
        'message', 'Your float balance (UGX ' || to_char(v_float, 'FM999,999,999,990') ||
                   ') is less than this payout (UGX ' || to_char(v_amount, 'FM999,999,999,990') ||
                   '). Ask the CFO/treasury to top up your float before claiming this request.');
    END IF;
  END IF;

  v_is_momo := COALESCE(v_w.payout_method, '') IN
    ('mobile_money', 'mtn_mobile_money', 'airtel_money');

  -- Server-side enforcement: the MoMo number and registered (screen) name the
  -- agent confirms at claim time MUST exactly match the withdrawal's stored
  -- payout details. This backstops the client-side confirmation dialog so a
  -- tampered or bypassed client cannot claim against the wrong target.
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