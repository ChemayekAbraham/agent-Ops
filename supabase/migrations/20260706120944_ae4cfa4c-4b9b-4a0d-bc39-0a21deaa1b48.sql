CREATE OR REPLACE FUNCTION public.agent_deposit_to_partner(p_agent_id uuid, p_partner_id uuid, p_amount numeric, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent_balance NUMERIC;
  v_partner_balance NUMERIC;
  v_txn_group UUID := gen_random_uuid();
  v_tracking_id TEXT;
  v_agent_name TEXT;
  v_partner_name TEXT;
  v_commission NUMERIC;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  END IF;

  IF p_agent_id = p_partner_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot deposit to yourself');
  END IF;

  SELECT balance INTO v_agent_balance FROM wallets WHERE user_id = p_agent_id;
  IF v_agent_balance IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Agent wallet not found');
  END IF;
  IF v_agent_balance < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error',
      format('Insufficient balance. Available: %s', v_agent_balance));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM proxy_agent_assignments
    WHERE agent_id = p_agent_id AND beneficiary_id = p_partner_id
      AND is_active = true
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'No active proxy relationship with this partner');
  END IF;

  SELECT full_name INTO v_agent_name FROM profiles WHERE id = p_agent_id;
  SELECT full_name INTO v_partner_name FROM profiles WHERE id = p_partner_id;

  v_tracking_id := 'PDEP-' || UPPER(SUBSTRING(gen_random_uuid()::TEXT FROM 1 FOR 8));
  -- 1% commission to the proxy agent on every partner deposit
  v_commission := ROUND(p_amount * 0.01);

  PERFORM set_config('wallet.sync_authorized', 'true', true);

  -- Leg 1: Deduct from agent wallet
  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id, currency, linked_party)
  VALUES (p_agent_id, p_amount, 'cash_out', 'wallet_transfer', 'proxy_agent_assignments', v_tracking_id,
    format('Deposit to partner %s — %s', v_partner_name, COALESCE(p_notes, v_tracking_id)),
    'wallet', v_txn_group, 'UGX', p_partner_id);

  -- Leg 2: Credit partner wallet
  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id, currency, linked_party)
  VALUES (p_partner_id, p_amount, 'cash_in', 'wallet_transfer', 'proxy_agent_assignments', v_tracking_id,
    format('Deposit from agent %s — %s', v_agent_name, COALESCE(p_notes, v_tracking_id)),
    'wallet', v_txn_group, 'UGX', p_agent_id);

  IF v_commission > 0 THEN
    -- Leg 3: Agent commission credit (wallet scope → routes to withdrawable)
    INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id, currency, linked_party)
    VALUES (p_agent_id, v_commission, 'cash_in', 'partner_commission', 'proxy_agent_assignments', v_tracking_id,
      format('1%% commission on %s deposit to %s', p_amount, v_partner_name),
      'wallet', v_txn_group, 'UGX', p_partner_id);

    -- Leg 4: Platform expense (platform scope — reduces money we have)
    INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id, currency, linked_party)
    VALUES (p_agent_id, v_commission, 'cash_out', 'partner_commission', 'proxy_agent_assignments', v_tracking_id,
      format('Partner commission expense: 1%% of %s for deposit to %s', p_amount, v_partner_name),
      'platform', v_txn_group, 'UGX', p_partner_id);
  END IF;

  -- Update wallet balances (keep aggregate + withdrawable bucket cache in sync with ledger truth)
  UPDATE wallets
     SET balance = balance - p_amount + v_commission,
         withdrawable_balance = COALESCE(withdrawable_balance, 0) - p_amount + v_commission,
         updated_at = NOW()
   WHERE user_id = p_agent_id;

  INSERT INTO wallets (user_id, balance, currency)
  VALUES (p_partner_id, 0, 'UGX')
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE wallets
     SET balance = balance + p_amount,
         withdrawable_balance = COALESCE(withdrawable_balance, 0) + p_amount,
         updated_at = NOW()
   WHERE user_id = p_partner_id;

  SELECT balance INTO v_agent_balance FROM wallets WHERE user_id = p_agent_id;
  SELECT balance INTO v_partner_balance FROM wallets WHERE user_id = p_partner_id;

  -- Audit log
  INSERT INTO system_events (event_type, actor_id, target_id, metadata)
  VALUES ('partner_commission_earned', p_agent_id, p_partner_id,
    jsonb_build_object(
      'deposit_amount', p_amount,
      'commission', v_commission,
      'commission_rate', 0.01,
      'tracking_id', v_tracking_id,
      'partner_name', v_partner_name,
      'txn_group_id', v_txn_group
    ));

  RETURN jsonb_build_object(
    'success', true,
    'amount', p_amount,
    'tracking_id', v_tracking_id,
    'agent_balance_after', v_agent_balance,
    'partner_balance_after', v_partner_balance,
    'partner_name', v_partner_name,
    'txn_group_id', v_txn_group,
    'commission_earned', v_commission
  );
END;
$function$;