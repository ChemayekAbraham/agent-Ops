-- Switch the user-facing cash withdrawal pickup code from WPO-XXXXX to a 4-digit numeric code.
ALTER TABLE public.payout_codes DROP CONSTRAINT IF EXISTS payout_codes_code_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_codes_active_code
  ON public.payout_codes (code)
  WHERE status IN ('pending', 'claimed');

CREATE OR REPLACE FUNCTION public.submit_withdrawal_request(
  p_amount numeric,
  p_payout_method text,
  p_mobile_money_number text DEFAULT NULL,
  p_mobile_money_name text DEFAULT NULL,
  p_mobile_money_provider text DEFAULT NULL,
  p_bank_name text DEFAULT NULL,
  p_bank_account_number text DEFAULT NULL,
  p_bank_account_name text DEFAULT NULL,
  p_client_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid            uuid := auth.uid();
  v_available      numeric;
  v_method         text  := lower(coalesce(p_payout_method, ''));
  v_provider       text;
  v_new_id         uuid;
  v_client_req_id  uuid := coalesce(p_client_request_id, gen_random_uuid());
  v_existing_id    uuid;
  v_existing_code  text;
  v_payout_code    text;
  v_qr_data        text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized',
      'message', 'You must be signed in to submit a withdrawal.');
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> floor(p_amount) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_amount',
      'message', 'Amount must be a positive whole number of UGX.');
  END IF;

  IF p_amount < 1000 THEN
    RETURN jsonb_build_object('success', false, 'code', 'amount_below_min',
      'message', 'Minimum withdrawal is UGX 1,000.');
  END IF;

  IF p_amount > 50000000 THEN
    RETURN jsonb_build_object('success', false, 'code', 'amount_above_max',
      'message', 'Maximum withdrawal per request is UGX 50,000,000.');
  END IF;

  IF v_method NOT IN ('mobile_money', 'bank_transfer', 'cash') THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_method',
      'message', 'Payout method must be mobile_money, bank_transfer, or cash.');
  END IF;

  IF v_method = 'mobile_money' THEN
    v_provider := lower(coalesce(p_mobile_money_provider, ''));
    IF v_provider NOT IN ('mtn', 'airtel') THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_provider',
        'message', 'Mobile money provider must be MTN or Airtel.');
    END IF;
    IF coalesce(btrim(p_mobile_money_number), '') = ''
       OR coalesce(btrim(p_mobile_money_name), '') = '' THEN
      RETURN jsonb_build_object('success', false, 'code', 'missing_momo_details',
        'message', 'Mobile money number and account name are required.');
    END IF;
    IF p_mobile_money_number !~ '^\+?[0-9 ]{9,15}$' THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_momo_number',
        'message', 'Mobile money number must be 9-15 digits.');
    END IF;
  ELSIF v_method = 'bank_transfer' THEN
    IF coalesce(btrim(p_bank_name), '') = ''
       OR coalesce(btrim(p_bank_account_number), '') = ''
       OR coalesce(btrim(p_bank_account_name), '') = '' THEN
      RETURN jsonb_build_object('success', false, 'code', 'missing_bank_details',
        'message', 'Bank name, account number, and account holder name are required.');
    END IF;
  END IF;

  v_available := public.get_user_available_balance(v_uid);

  IF v_available IS NULL OR v_available < p_amount THEN
    RETURN jsonb_build_object(
      'success', false, 'code', 'insufficient_funds',
      'message', format(
        'Insufficient funds. Available: UGX %s, requested: UGX %s.',
        to_char(coalesce(v_available, 0), 'FM999,999,999'),
        to_char(p_amount, 'FM999,999,999')
      ),
      'available', coalesce(v_available, 0)
    );
  END IF;

  SELECT id, payout_code
    INTO v_existing_id, v_existing_code
  FROM public.withdrawal_requests
  WHERE client_request_id = v_client_req_id
    AND user_id = v_uid
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'code', 'already_submitted',
      'request_id', v_existing_id,
      'payout_code', v_existing_code,
      'available_after', v_available - p_amount
    );
  END IF;

  IF v_method = 'cash' THEN
    LOOP
      v_payout_code := lpad((floor(random() * 10000))::int::text, 4, '0');
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM public.payout_codes
        WHERE code = v_payout_code
          AND status IN ('pending', 'claimed')
      );
    END LOOP;
  END IF;

  INSERT INTO public.withdrawal_requests (
    user_id, amount, status, payout_method,
    mobile_money_number, mobile_money_name, mobile_money_provider,
    bank_name, bank_account_number, bank_account_name,
    client_request_id, initiated_by, payout_code
  ) VALUES (
    v_uid, p_amount, 'pending', v_method,
    CASE WHEN v_method = 'mobile_money' THEN btrim(p_mobile_money_number) END,
    CASE
      WHEN v_method = 'mobile_money' THEN btrim(p_mobile_money_name)
      WHEN v_method = 'bank_transfer' THEN btrim(p_bank_account_name)
      ELSE 'Cash Pickup'
    END,
    CASE
      WHEN v_method = 'mobile_money' THEN v_provider
      WHEN v_method = 'bank_transfer' THEN 'bank'
      ELSE 'cash'
    END,
    CASE WHEN v_method = 'bank_transfer' THEN btrim(p_bank_name) END,
    CASE WHEN v_method = 'bank_transfer' THEN btrim(p_bank_account_number) END,
    CASE WHEN v_method = 'bank_transfer' THEN btrim(p_bank_account_name) END,
    v_client_req_id, v_uid,
    v_payout_code
  )
  RETURNING id INTO v_new_id;

  IF v_method = 'cash' THEN
    v_qr_data := jsonb_build_object(
      'code', v_payout_code,
      'amount', p_amount,
      'userId', v_uid,
      'withdrawalId', v_new_id
    )::text;

    INSERT INTO public.payout_codes (
      withdrawal_request_id, user_id, code, qr_data, amount, status
    ) VALUES (
      v_new_id, v_uid, v_payout_code, v_qr_data, p_amount, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'code', 'submitted',
    'request_id', v_new_id,
    'payout_code', v_payout_code,
    'available_after', v_available - p_amount
  );

EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'code', 'duplicate_pending',
      'message', 'You already have a pending withdrawal with these details. Wait for it to be approved or rejected.');
  WHEN insufficient_privilege THEN
    RETURN jsonb_build_object('success', false, 'code', 'forbidden',
      'message', 'Withdrawals from this account must be routed through your assigned agent.');
  WHEN raise_exception THEN
    RETURN jsonb_build_object('success', false, 'code', 'rejected', 'message', SQLERRM);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.submit_withdrawal_request(
  numeric, text, text, text, text, text, text, text, uuid
) TO anon, authenticated, service_role;

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
    IF v_code.status IN ('paid', 'claimed') THEN
      RETURN jsonb_build_object('success', false, 'code', 'already_used',
        'message', 'This code has already been used at the counter and cannot be reissued.');
    END IF;

    v_is_expired := (v_code.status = 'expired') OR (v_code.expires_at <= now());

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

  LOOP
    v_new_code := lpad((floor(random() * 10000))::int::text, 4, '0');
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.payout_codes
      WHERE code = v_new_code
        AND status IN ('pending', 'claimed')
    );
  END LOOP;

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