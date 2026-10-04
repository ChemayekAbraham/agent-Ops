CREATE OR REPLACE FUNCTION public.agent_allocate_tenant_payment(
  p_agent_id uuid,
  p_tenant_id uuid,
  p_rent_request_id uuid,
  p_amount numeric,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_float_balance      numeric := 0;
  v_commission_balance numeric := 0;
  v_outstanding        numeric;
  v_txn_group          uuid;
  v_tracking_id        text;
  v_collection_id      uuid;
  v_landlord_id        uuid;
  v_landlord_name      text;
  v_new_status         text;
  v_commission_earned  numeric;
  v_current_status     text;
  v_total_repayment    numeric;
  v_amount_repaid      numeric;
  v_idempotency_key    text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  END IF;

  -- p_agent_id is an authenticated app user, so it is safe to ensure an
  -- identity wallet row. Landlord ids on rent_requests reference public.landlords,
  -- not auth users, so they must never be inserted into wallets_physical.
  INSERT INTO public.wallets_physical (user_id)
  VALUES (p_agent_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT
    GREATEST(0, COALESCE(float_balance, 0)),
    GREATEST(0, COALESCE(withdrawable_balance, 0))
  INTO v_float_balance, v_commission_balance
  FROM public.wallets
  WHERE user_id = p_agent_id;

  IF v_float_balance < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'INSUFFICIENT_FLOAT',
      'error', format(
        'Insufficient operations float. Available: %s, Requested: %s. Commission cannot be used for tenant payments.',
        v_float_balance, p_amount
      )
    );
  END IF;

  SELECT
    rr.landlord_id,
    l.name,
    rr.status,
    COALESCE(rr.total_repayment, 0),
    COALESCE(rr.amount_repaid, 0)
  INTO v_landlord_id, v_landlord_name, v_current_status, v_total_repayment, v_amount_repaid
  FROM public.rent_requests rr
  LEFT JOIN public.landlords l ON l.id = rr.landlord_id
  WHERE rr.id = p_rent_request_id;

  IF v_landlord_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rent request not found');
  END IF;

  v_outstanding := GREATEST(0, v_total_repayment - v_amount_repaid);

  IF p_amount > v_outstanding THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'AMOUNT_EXCEEDS_OUTSTANDING',
      'error', format('Amount exceeds outstanding balance (%s).', v_outstanding)
    );
  END IF;

  v_commission_earned := round(p_amount * 0.10, 2);
  v_idempotency_key := format(
    'agent_allocate_tenant_payment:%s:%s:%s:%s',
    p_agent_id,
    p_tenant_id,
    p_rent_request_id,
    p_amount
  );

  v_txn_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id',       p_agent_id,
        'amount',        p_amount,
        'direction',     'cash_out',
        'category',      'rent_payment_for_tenant',
        'ledger_scope',  'wallet',
        'classification','production',
        'description',   'Float allocated to tenant rent',
        'linked_party',  v_landlord_id,
        'recipient_type','operational_wallet',
        'source_table',  'agent_collections',
        'source_id',     p_rent_request_id
      ),
      jsonb_build_object(
        'user_id',       p_tenant_id,
        'amount',        p_amount,
        'direction',     'cash_in',
        'category',      'rent_receivable_created',
        'ledger_scope',  'bridge',
        'classification','production',
        'description',   format('Tenant rent allocation settled for landlord %s', COALESCE(v_landlord_name, 'Unknown')),
        'linked_party',  v_landlord_id,
        'source_table',  'agent_collections',
        'source_id',     p_rent_request_id
      ),
      jsonb_build_object(
        'user_id',       p_agent_id,
        'amount',        v_commission_earned,
        'direction',     'cash_in',
        'category',      'agent_commission_earned',
        'ledger_scope',  'wallet',
        'classification','production',
        'description',   '10% commission on float allocation',
        'recipient_type','user',
        'source_table',  'agent_collections',
        'source_id',     p_rent_request_id
      ),
      jsonb_build_object(
        'user_id',       p_agent_id,
        'amount',        v_commission_earned,
        'direction',     'cash_out',
        'category',      'agent_commission_payable',
        'ledger_scope',  'platform',
        'classification','production',
        'description',   'Platform commission payout (10%)',
        'source_table',  'agent_collections',
        'source_id',     p_rent_request_id
      )
    ),
    v_idempotency_key,
    true
  );

  v_tracking_id := 'AGT-' || substr(v_txn_group::text, 1, 8);

  v_new_status := CASE
    WHEN v_amount_repaid + p_amount >= v_total_repayment THEN 'completed'
    WHEN v_current_status IN ('funded', 'disbursed', 'coo_approved', 'agent_verified') THEN 'repaying'
    ELSE v_current_status
  END;

  UPDATE public.rent_requests
  SET amount_repaid = COALESCE(amount_repaid, 0) + p_amount,
      status = v_new_status,
      updated_at = now()
  WHERE id = p_rent_request_id;

  INSERT INTO public.repayments (tenant_id, rent_request_id, amount, created_at)
  VALUES (p_tenant_id, p_rent_request_id, p_amount, now());

  INSERT INTO public.agent_collections (
    agent_id, tenant_id, amount, payment_method, tracking_id, notes, float_before, float_after
  ) VALUES (
    p_agent_id, p_tenant_id, p_amount, 'cash', v_tracking_id, p_notes,
    v_float_balance, v_float_balance - p_amount
  ) RETURNING id INTO v_collection_id;

  RETURN jsonb_build_object(
    'success', true,
    'tracking_id', v_tracking_id,
    'transaction_group', v_txn_group,
    'amount', p_amount,
    'float_before', v_float_balance,
    'float_after', v_float_balance - p_amount,
    'outstanding_remaining', GREATEST(0, v_outstanding - p_amount),
    'outstanding_after', GREATEST(0, v_outstanding - p_amount),
    'commission', jsonb_build_object('credited_commission', v_commission_earned),
    'commission_earned', v_commission_earned,
    'commission_balance', v_commission_balance + v_commission_earned,
    'collection_id', v_collection_id
  );
END;
$function$;