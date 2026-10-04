CREATE OR REPLACE FUNCTION public.agent_allocate_tenant_payment(
  p_agent_id uuid,
  p_tenant_id uuid,
  p_rent_request_id uuid,
  p_amount numeric,
  p_notes text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_float_balance numeric := 0;
  v_commission_balance numeric := 0;
  v_outstanding numeric;
  v_txn_group uuid := gen_random_uuid();
  v_tracking_id text;
  v_collection_id uuid;
  v_landlord_id uuid;
  v_new_status text;
  v_commission_earned numeric;
  v_current_status text;
  v_total_repayment numeric;
  v_amount_repaid numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  END IF;

  INSERT INTO public.wallets (user_id, balance)
  VALUES (p_agent_id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT
    GREATEST(0, COALESCE(float_balance, 0)),
    GREATEST(0, COALESCE(withdrawable_balance, 0))
  INTO v_float_balance, v_commission_balance
  FROM public.wallets
  WHERE user_id = p_agent_id
  FOR UPDATE;

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
    landlord_id,
    status,
    COALESCE(total_repayment, 0),
    COALESCE(amount_repaid, 0)
  INTO v_landlord_id, v_current_status, v_total_repayment, v_amount_repaid
  FROM public.rent_requests
  WHERE id = p_rent_request_id;

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

  v_tracking_id := 'AGT-' || substr(v_txn_group::text, 1, 8);
  v_commission_earned := round(p_amount * 0.10, 2);

  PERFORM set_config('ledger.authorized', 'true', true);

  INSERT INTO public.general_ledger (
    user_id, amount, direction, category, source_table, source_id,
    description, ledger_scope, transaction_group_id, classification
  ) VALUES (
    p_agent_id, p_amount, 'cash_out', 'agent_float_used_for_rent', 'agent_collections', p_rent_request_id,
    format('Float used for tenant payment — %s', v_tracking_id), 'wallet', v_txn_group, 'production'
  );

  INSERT INTO public.general_ledger (
    user_id, amount, direction, category, source_table, source_id,
    description, ledger_scope, transaction_group_id, classification
  ) VALUES (
    p_agent_id, p_amount, 'cash_in', 'tenant_repayment', 'agent_collections', p_rent_request_id,
    format('Tenant repayment via agent allocation — %s', v_tracking_id), 'platform', v_txn_group, 'production'
  );

  PERFORM public.apply_wallet_movement(
    p_agent_id,
    'agent_float_used_for_rent',
    p_amount,
    'cash_out',
    'operational_wallet'
  );

  IF v_commission_earned > 0 THEN
    INSERT INTO public.general_ledger (
      user_id, amount, direction, category, source_table, source_id,
      description, ledger_scope, transaction_group_id, classification
    ) VALUES (
      p_agent_id, v_commission_earned, 'cash_in', 'agent_commission_earned', 'agent_collections', p_rent_request_id,
      format('10%% commission on float allocation — %s', v_tracking_id), 'wallet', v_txn_group, 'production'
    );

    INSERT INTO public.general_ledger (
      user_id, amount, direction, category, source_table, source_id,
      description, ledger_scope, transaction_group_id, classification
    ) VALUES (
      p_agent_id, v_commission_earned, 'cash_out', 'agent_commission_earned', 'agent_collections', p_rent_request_id,
      format('Platform commission expense for allocation — %s', v_tracking_id), 'platform', v_txn_group, 'production'
    );

    PERFORM public.apply_wallet_movement(
      p_agent_id,
      'agent_commission_earned',
      v_commission_earned,
      'cash_in',
      'user'
    );
  END IF;

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
    'amount', p_amount,
    'float_before', v_float_balance,
    'float_after', v_float_balance - p_amount,
    'outstanding_remaining', GREATEST(0, v_outstanding - p_amount),
    'outstanding_after', GREATEST(0, v_outstanding - p_amount),
    'commission', jsonb_build_object('credited_commission', v_commission_earned),
    'commission_balance', v_commission_balance + v_commission_earned,
    'collection_id', v_collection_id
  );
END;
$function$;