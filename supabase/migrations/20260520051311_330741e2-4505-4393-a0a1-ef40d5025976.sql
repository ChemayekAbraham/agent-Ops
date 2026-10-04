-- Server-side validation RPC for self-service withdrawals.
-- This replaces the direct client INSERT path so that amount, balance,
-- and authorization are ALL re-checked server-side, independent of any
-- client UI (no PIN required).

CREATE OR REPLACE FUNCTION public.submit_withdrawal_request(
  p_amount             numeric,
  p_payout_method      text,
  p_mobile_money_number text DEFAULT NULL,
  p_mobile_money_name   text DEFAULT NULL,
  p_mobile_money_provider text DEFAULT NULL,
  p_bank_name           text DEFAULT NULL,
  p_bank_account_number text DEFAULT NULL,
  p_bank_account_name   text DEFAULT NULL,
  p_client_request_id   uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid           uuid := auth.uid();
  v_available     numeric;
  v_method        text  := lower(coalesce(p_payout_method, ''));
  v_provider      text;
  v_new_id        uuid;
  v_client_req_id uuid := coalesce(p_client_request_id, gen_random_uuid());
  v_existing_id   uuid;
BEGIN
  ------------------------------------------------------------------
  -- 1. AUTHORIZATION
  ------------------------------------------------------------------
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'unauthorized',
      'message', 'You must be signed in to submit a withdrawal.'
    );
  END IF;

  ------------------------------------------------------------------
  -- 2. AMOUNT VALIDATION
  ------------------------------------------------------------------
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> floor(p_amount) THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'invalid_amount',
      'message', 'Amount must be a positive whole number of UGX.'
    );
  END IF;

  IF p_amount < 1000 THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'amount_below_min',
      'message', 'Minimum withdrawal is UGX 1,000.'
    );
  END IF;

  IF p_amount > 50000000 THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'amount_above_max',
      'message', 'Maximum withdrawal per request is UGX 50,000,000.'
    );
  END IF;

  ------------------------------------------------------------------
  -- 3. METHOD + DESTINATION VALIDATION
  ------------------------------------------------------------------
  IF v_method NOT IN ('mobile_money', 'bank_transfer', 'cash') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'invalid_method',
      'message', 'Payout method must be mobile_money, bank_transfer, or cash.'
    );
  END IF;

  IF v_method = 'mobile_money' THEN
    v_provider := lower(coalesce(p_mobile_money_provider, ''));
    IF v_provider NOT IN ('mtn', 'airtel') THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'invalid_provider',
        'message', 'Mobile money provider must be MTN or Airtel.'
      );
    END IF;
    IF coalesce(btrim(p_mobile_money_number), '') = ''
       OR coalesce(btrim(p_mobile_money_name), '') = '' THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'missing_momo_details',
        'message', 'Mobile money number and account name are required.'
      );
    END IF;
    IF p_mobile_money_number !~ '^\+?[0-9 ]{9,15}$' THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'invalid_momo_number',
        'message', 'Mobile money number must be 9-15 digits.'
      );
    END IF;
  ELSIF v_method = 'bank_transfer' THEN
    IF coalesce(btrim(p_bank_name), '') = ''
       OR coalesce(btrim(p_bank_account_number), '') = ''
       OR coalesce(btrim(p_bank_account_name), '') = '' THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'missing_bank_details',
        'message', 'Bank name, account number, and account holder name are required.'
      );
    END IF;
  END IF;
  -- cash: no extra destination fields required

  ------------------------------------------------------------------
  -- 4. BALANCE VALIDATION (ledger-backed strict rule)
  ------------------------------------------------------------------
  v_available := public.get_user_available_balance(v_uid);

  IF v_available IS NULL OR v_available < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'insufficient_funds',
      'message', format(
        'Insufficient funds. Available: UGX %s, requested: UGX %s.',
        to_char(coalesce(v_available, 0), 'FM999,999,999'),
        to_char(p_amount, 'FM999,999,999')
      ),
      'available', coalesce(v_available, 0)
    );
  END IF;

  ------------------------------------------------------------------
  -- 5. IDEMPOTENCY — if client_request_id already exists for this user,
  -- return the existing row instead of erroring.
  ------------------------------------------------------------------
  SELECT id INTO v_existing_id
  FROM public.withdrawal_requests
  WHERE client_request_id = v_client_req_id
    AND user_id = v_uid
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'code', 'already_submitted',
      'request_id', v_existing_id,
      'available_after', v_available - p_amount
    );
  END IF;

  ------------------------------------------------------------------
  -- 6. INSERT (server enforces user_id = auth.uid())
  ------------------------------------------------------------------
  INSERT INTO public.withdrawal_requests (
    user_id,
    amount,
    status,
    payout_method,
    mobile_money_number,
    mobile_money_name,
    mobile_money_provider,
    bank_name,
    bank_account_number,
    bank_account_name,
    client_request_id,
    initiated_by
  ) VALUES (
    v_uid,
    p_amount,
    'pending',
    v_method,
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
    v_client_req_id,
    v_uid
  )
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object(
    'success', true,
    'code', 'submitted',
    'request_id', v_new_id,
    'available_after', v_available - p_amount
  );

EXCEPTION
  WHEN unique_violation THEN
    -- Duplicate-pending or idempotency collision raised by triggers.
    RETURN jsonb_build_object(
      'success', false,
      'code', 'duplicate_pending',
      'message', 'You already have a pending withdrawal with these details. Wait for it to be approved or rejected.'
    );
  WHEN insufficient_privilege THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'forbidden',
      'message', 'Withdrawals from this account must be routed through your assigned agent.'
    );
  WHEN raise_exception THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'rejected',
      'message', SQLERRM
    );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_withdrawal_request(numeric, text, text, text, text, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_withdrawal_request(numeric, text, text, text, text, text, text, text, uuid) TO authenticated;