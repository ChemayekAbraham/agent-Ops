CREATE OR REPLACE FUNCTION public.resend_payout_code(
  p_withdrawal_request_id uuid,
  p_cooldown_seconds integer DEFAULT 90
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_wr         record;
  v_code       record;
  v_cooldown   interval := make_interval(secs => greatest(coalesce(p_cooldown_seconds, 90), 0));
  v_is_expired boolean := false;
  v_retry      integer;
  v_new_code   text;
  v_qr         text;
  v_new_id     uuid;
  v_expires    timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized',
      'message', 'You must be signed in to request a new code.');
  END IF;

  SELECT id, user_id, status, lower(coalesce(payout_method, '')) AS method, amount
    INTO v_wr
  FROM public.withdrawal_requests
  WHERE id = p_withdrawal_request_id;

  IF v_wr.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_found',
      'message', 'Withdrawal request not found.');
  END IF;

  IF v_wr.user_id <> v_uid THEN
    RETURN jsonb_build_object('success', false, 'code', 'forbidden',
      'message', 'You can only resend a code for your own withdrawal.');
  END IF;

  IF v_wr.method NOT IN ('cash', 'cash_pickup') THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_cash',
      'message', 'Only cash pickups use a receipt code.');
  END IF;

  -- Only resend while the withdrawal is still awaiting Financial Ops.
  IF v_wr.status NOT IN ('pending', 'requested', 'manager_approved') THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_resendable',
      'message', 'This withdrawal is no longer awaiting verification, so a new code cannot be issued.');
  END IF;

  SELECT id, code, status, expires_at, created_at
    INTO v_code
  FROM public.payout_codes
  WHERE withdrawal_request_id = p_withdrawal_request_id
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_code.id IS NOT NULL THEN
    -- A code that already settled at the counter can never be reissued.
    IF v_code.status IN ('paid', 'claimed') THEN
      RETURN jsonb_build_object('success', false, 'code', 'already_used',
        'message', 'This code has already been used at the counter and cannot be reissued.');
    END IF;

    v_is_expired := (v_code.status = 'expired') OR (v_code.expires_at <= now());

    -- Still-valid code inside the cooldown window → block and report the wait.
    IF NOT v_is_expired AND now() < (v_code.created_at + v_cooldown) THEN
      v_retry := ceil(extract(epoch FROM ((v_code.created_at + v_cooldown) - now())))::int;
      RETURN jsonb_build_object(
        'success', false,
        'code', 'cooldown_active',
        'retry_after_seconds', v_retry,
        'expires_at', v_code.expires_at,
        'payout_code', v_code.code,
        'message', format('Your current code is still valid. You can request a new one in %s second(s).', v_retry)
      );
    END IF;
  END IF;

  -- Eligible (expired OR cooldown elapsed OR no prior code): issue a fresh code.
  LOOP
    v_new_code := 'WPO-' || upper(substr(md5(gen_random_uuid()::text), 1, 5));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.payout_codes WHERE code = v_new_code);
  END LOOP;

  -- Retire the previous active code so the latest row is the only live one.
  IF v_code.id IS NOT NULL AND v_code.status NOT IN ('paid', 'claimed', 'expired') THEN
    UPDATE public.payout_codes SET status = 'expired' WHERE id = v_code.id;
  END IF;

  v_qr := jsonb_build_object(
    'code', v_new_code, 'amount', v_wr.amount, 'userId', v_uid, 'withdrawalId', v_wr.id
  )::text;

  INSERT INTO public.payout_codes (withdrawal_request_id, user_id, code, qr_data, amount, status)
  VALUES (v_wr.id, v_uid, v_new_code, v_qr, v_wr.amount, 'pending')
  RETURNING id, expires_at INTO v_new_id, v_expires;

  UPDATE public.withdrawal_requests SET payout_code = v_new_code WHERE id = v_wr.id;

  INSERT INTO public.payout_code_audit_log (
    withdrawal_request_id, payout_code_id, outcome, status_result,
    request_owner_id, amount, metadata
  ) VALUES (
    v_wr.id, v_new_id, 'code_resent', 'pending',
    v_uid, v_wr.amount,
    jsonb_build_object(
      'reason', CASE
                  WHEN v_code.id IS NULL THEN 'no_prior_code'
                  WHEN v_is_expired THEN 'previous_expired'
                  ELSE 'cooldown_elapsed'
                END,
      'previous_code_id', v_code.id,
      'cooldown_seconds', p_cooldown_seconds
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'code', 'resent',
    'payout_code', v_new_code,
    'expires_at', v_expires
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.resend_payout_code(uuid, integer) TO authenticated;