
-- Fix get_agent_split_balances to clamp float to 0
CREATE OR REPLACE FUNCTION public.get_agent_split_balances(p_agent_id UUID)
RETURNS TABLE(float_balance NUMERIC, commission_balance NUMERIC)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total numeric := 0;
  v_commission numeric := 0;
BEGIN
  -- Total wallet balance
  SELECT COALESCE(
    SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END),
    0
  ) INTO v_total
  FROM general_ledger
  WHERE user_id = p_agent_id
    AND ledger_scope = 'wallet';

  -- Commission balance (specific categories only)
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

  -- Float = total - commission, but NEVER negative
  RETURN QUERY SELECT GREATEST(0, v_total - v_commission) AS float_balance, v_commission AS commission_balance;
END;
$$;

-- Fix agent_allocate_tenant_payment to enforce non-negative float
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

  -- Float = total - commission, clamped to 0
  v_float_balance := GREATEST(0, v_total_wallet - v_commission);

  IF v_float_balance < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error',
      format('Insufficient float balance. Available: %s, Requested: %s', v_float_balance, p_amount));
  END IF;

  -- Also check wallet balance itself (cannot go below 0)
  SELECT balance INTO v_wallet_balance FROM wallets WHERE user_id = p_agent_id;
  IF v_wallet_balance IS NULL OR v_wallet_balance < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error',
      format('Insufficient wallet balance. Available: %s', COALESCE(v_wallet_balance, 0)));
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

  -- 5. Record in repayments table
  INSERT INTO repayments (tenant_id, rent_request_id, amount)
  VALUES (p_tenant_id, p_rent_request_id, p_amount);

  -- 6. Reduce landlord rent_balance_due
  IF v_landlord_id IS NOT NULL THEN
    UPDATE landlords
    SET rent_balance_due = GREATEST(0, rent_balance_due - p_amount),
        rent_last_paid_at = NOW(),
        rent_last_paid_amount = p_amount
    WHERE id = v_landlord_id;
  END IF;

  -- 7. Credit agent commission (10%)
  v_commission_result := jsonb_build_object(
    'credited_commission', ROUND(p_amount * 0.10),
    'commission_rate', 0.10
  );

  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
  VALUES (p_agent_id, ROUND(p_amount * 0.10), 'cash_in', 'agent_commission', 'agent_collections', p_rent_request_id::TEXT,
    format('10%% commission on tenant allocation — %s', v_tracking_id), 'wallet', v_txn_group);

  -- Return success
  RETURN jsonb_build_object(
    'success', true,
    'amount', p_amount,
    'tracking_id', v_tracking_id,
    'float_before', v_float_balance,
    'float_after', GREATEST(0, v_float_balance - p_amount),
    'outstanding_remaining', v_outstanding - p_amount,
    'commission', v_commission_result,
    'txn_group_id', v_txn_group
  );
END;
$$;
