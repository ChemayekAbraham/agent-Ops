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
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  END IF;

  SELECT COALESCE(SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END),0)
  INTO v_total_wallet
  FROM general_ledger
  WHERE user_id = p_agent_id AND ledger_scope = 'wallet';

  SELECT COALESCE(SUM(
    CASE
      WHEN direction IN ('cash_in','credit')
        AND category IN ('agent_commission_earned','agent_commission','agent_bonus','referral_bonus','proxy_investment_commission','agent_advance_credit','partner_commission')
      THEN amount
      WHEN direction IN ('cash_out','debit')
        AND category IN ('agent_commission_withdrawal','agent_commission_used_for_rent')
      THEN -amount
      ELSE 0
    END),0)
  INTO v_commission
  FROM general_ledger
  WHERE user_id = p_agent_id AND ledger_scope = 'wallet';

  v_float_balance := GREATEST(0, v_total_wallet - v_commission);

  IF v_float_balance < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error',
      format('Insufficient float balance. Available: %s, Requested: %s', v_float_balance, p_amount));
  END IF;

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

  -- Authorize ledger writes for this transaction (required by guard_ledger_write trigger)
  PERFORM set_config('ledger.authorized', 'true', true);
  PERFORM set_config('wallet.sync_authorized', 'true', true);

  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
  VALUES (p_agent_id, p_amount, 'cash_out', 'agent_float_used_for_rent', 'agent_collections', p_rent_request_id,
    format('Float allocation for tenant payment — %s', v_tracking_id), 'wallet', v_txn_group);

  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
  VALUES (p_agent_id, p_amount, 'cash_in', 'tenant_repayment', 'agent_collections', p_rent_request_id,
    format('Tenant repayment via agent allocation — %s', v_tracking_id), 'platform', v_txn_group);

  UPDATE wallets SET balance = GREATEST(0, balance - p_amount), updated_at = NOW()
  WHERE user_id = p_agent_id;

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

  INSERT INTO repayments (rent_request_id, amount, method, status, notes, created_at)
  VALUES (p_rent_request_id, p_amount, 'agent_float', 'completed',
    format('Agent float allocation by %s — %s. %s', p_agent_id, v_tracking_id, COALESCE(p_notes, '')),
    NOW());

  INSERT INTO agent_collections (agent_id, tenant_id, amount, payment_method, tracking_id, notes, float_before, float_after)
  VALUES (p_agent_id, p_tenant_id, p_amount, 'cash', v_tracking_id,
    format('Float allocation — %s', COALESCE(p_notes, '')),
    v_float_balance, v_float_balance - p_amount)
  RETURNING id INTO v_collection_id;

  IF v_landlord_id IS NOT NULL THEN
    UPDATE landlords
    SET rent_balance_due = GREATEST(0, COALESCE(rent_balance_due, 0) - p_amount),
        updated_at = NOW()
    WHERE id = v_landlord_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'tracking_id', v_tracking_id,
    'amount', p_amount,
    'float_before', v_float_balance,
    'float_after', v_float_balance - p_amount,
    'outstanding_remaining', GREATEST(0, v_outstanding - p_amount),
    'outstanding_after', GREATEST(0, v_outstanding - p_amount),
    'commission', jsonb_build_object('credited_commission', ROUND(p_amount * 0.10)),
    'collection_id', v_collection_id
  );
END;
$function$;