
CREATE OR REPLACE FUNCTION public.agent_allocate_tenant_payment(
  p_agent_id UUID,
  p_tenant_id UUID,
  p_rent_request_id UUID,
  p_amount NUMERIC,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet_balance NUMERIC;
  v_float_balance NUMERIC;
  v_new_balance NUMERIC;
  v_outstanding NUMERIC;
  v_txn_group UUID := gen_random_uuid();
  v_tracking_id TEXT;
  v_collection_id UUID;
  v_commission_result JSONB;
  v_event_ref TEXT;
  v_total_wallet NUMERIC;
  v_commission NUMERIC;
  v_landlord_id UUID;
  v_new_status TEXT;
BEGIN
  -- Validate amount
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  END IF;

  -- Get agent float balance using same logic as get_agent_split_balances
  SELECT COALESCE(
    SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END),
    0
  ) INTO v_total_wallet
  FROM general_ledger
  WHERE user_id = p_agent_id
    AND ledger_scope = 'wallet';

  SELECT COALESCE(
    SUM(
      CASE
        WHEN direction IN ('cash_in','credit')
          AND category IN (
            'agent_commission_earned',
            'agent_commission',
            'agent_bonus',
            'referral_bonus',
            'proxy_investment_commission',
            'agent_advance_credit'
          )
        THEN amount
        WHEN direction IN ('cash_out','debit')
          AND category IN (
            'agent_commission_withdrawal',
            'agent_commission_used_for_rent',
            'tenant_default_charge'
          )
        THEN -amount
        ELSE 0
      END
    ),
    0
  ) INTO v_commission
  FROM general_ledger
  WHERE user_id = p_agent_id
    AND ledger_scope = 'wallet';

  v_float_balance := v_total_wallet - v_commission;

  IF v_float_balance < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error',
      format('Insufficient float balance. Available: %s, Requested: %s', v_float_balance, p_amount));
  END IF;

  -- Check outstanding on rent request and get landlord_id
  SELECT (total_repayment - amount_repaid), landlord_id
  INTO v_outstanding, v_landlord_id
  FROM rent_requests
  WHERE id = p_rent_request_id AND tenant_id = p_tenant_id;

  IF v_outstanding IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rent request not found');
  END IF;

  IF p_amount > v_outstanding THEN
    RETURN jsonb_build_object('success', false, 'error',
      format('Amount exceeds outstanding balance of %s', v_outstanding));
  END IF;

  v_tracking_id := 'ALLOC-' || UPPER(SUBSTRING(gen_random_uuid()::TEXT FROM 1 FOR 8));

  PERFORM set_config('wallet.sync_authorized', 'true', true);

  -- 1. Deduct from agent wallet (float out)
  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
  VALUES (p_agent_id, p_amount, 'cash_out', 'agent_float_used_for_rent', 'agent_collections', p_rent_request_id::TEXT,
    format('Float allocation for tenant payment — %s', v_tracking_id), 'wallet', v_txn_group);

  -- 2. Credit platform (money we have)
  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
  VALUES (p_agent_id, p_amount, 'cash_in', 'tenant_repayment', 'agent_collections', p_rent_request_id::TEXT,
    format('Tenant repayment via agent allocation — %s', v_tracking_id), 'platform', v_txn_group);

  -- 3. Update wallet balance
  UPDATE wallets SET balance = balance - p_amount, updated_at = NOW()
  WHERE user_id = p_agent_id;

  -- 4. Update rent request amount_repaid and status
  v_new_status := CASE
    WHEN (SELECT amount_repaid FROM rent_requests WHERE id = p_rent_request_id) + p_amount >= 
         (SELECT total_repayment FROM rent_requests WHERE id = p_rent_request_id) THEN 'completed'
    WHEN (SELECT status FROM rent_requests WHERE id = p_rent_request_id) IN ('disbursed', 'funded', 'approved') THEN 'repaying'
    ELSE (SELECT status FROM rent_requests WHERE id = p_rent_request_id)
  END;

  UPDATE rent_requests
  SET amount_repaid = amount_repaid + p_amount,
      status = v_new_status,
      updated_at = NOW()
  WHERE id = p_rent_request_id;

  -- 5. Record in repayments table (was missing!)
  INSERT INTO repayments (tenant_id, rent_request_id, amount)
  VALUES (p_tenant_id, p_rent_request_id, p_amount);

  -- 6. Reduce landlord rent_balance_due (money we owe - was missing!)
  IF v_landlord_id IS NOT NULL THEN
    UPDATE landlords
    SET rent_balance_due = GREATEST(0, rent_balance_due - p_amount),
        rent_last_paid_at = NOW(),
        rent_last_paid_amount = p_amount
    WHERE id = v_landlord_id;
  END IF;

  -- 7. Record in agent_collections
  INSERT INTO agent_collections (agent_id, tenant_id, amount, payment_method, tracking_id, notes, float_before, float_after)
  VALUES (p_agent_id, p_tenant_id, p_amount, 'cash', v_tracking_id, COALESCE(p_notes, 'Float allocation to tenant'), v_float_balance, v_float_balance - p_amount)
  RETURNING id INTO v_collection_id;

  -- 8. Credit commission (10% via existing engine)
  v_event_ref := 'alloc-' || v_collection_id::TEXT;
  SELECT credit_agent_rent_commission(p_rent_request_id, p_amount, p_tenant_id, v_event_ref)
  INTO v_commission_result;

  v_new_balance := v_float_balance - p_amount;

  RETURN jsonb_build_object(
    'success', true,
    'collection_id', v_collection_id,
    'tracking_id', v_tracking_id,
    'amount', p_amount,
    'float_before', v_float_balance,
    'float_after', v_new_balance,
    'outstanding_remaining', v_outstanding - p_amount,
    'commission', v_commission_result,
    'tenant_id', p_tenant_id,
    'rent_request_id', p_rent_request_id
  );
END;
$$;
