
CREATE OR REPLACE FUNCTION public.agent_deposit_to_partner(
  p_agent_id UUID,
  p_partner_id UUID,
  p_amount NUMERIC,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent_balance NUMERIC;
  v_partner_balance NUMERIC;
  v_txn_group UUID := gen_random_uuid();
  v_tracking_id TEXT;
  v_agent_name TEXT;
  v_partner_name TEXT;
BEGIN
  -- Validate
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  END IF;

  IF p_agent_id = p_partner_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot deposit to yourself');
  END IF;

  -- Check agent wallet
  SELECT balance INTO v_agent_balance FROM wallets WHERE user_id = p_agent_id;
  IF v_agent_balance IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Agent wallet not found');
  END IF;
  IF v_agent_balance < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error',
      format('Insufficient balance. Available: %s', v_agent_balance));
  END IF;

  -- Verify proxy relationship exists
  IF NOT EXISTS (
    SELECT 1 FROM proxy_agent_assignments
    WHERE agent_id = p_agent_id AND beneficiary_id = p_partner_id
      AND is_active = true
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'No active proxy relationship with this partner');
  END IF;

  -- Get names
  SELECT full_name INTO v_agent_name FROM profiles WHERE id = p_agent_id;
  SELECT full_name INTO v_partner_name FROM profiles WHERE id = p_partner_id;

  v_tracking_id := 'PDEP-' || UPPER(SUBSTRING(gen_random_uuid()::TEXT FROM 1 FOR 8));

  PERFORM set_config('wallet.sync_authorized', 'true', true);

  -- 1. Deduct from agent wallet (ledger)
  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id, currency, linked_party)
  VALUES (p_agent_id, p_amount, 'cash_out', 'wallet_transfer', 'proxy_agent_assignments', v_tracking_id,
    format('Deposit to partner %s — %s', v_partner_name, COALESCE(p_notes, v_tracking_id)),
    'wallet', v_txn_group, 'UGX', p_partner_id);

  -- 2. Credit partner wallet (ledger)
  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id, currency, linked_party)
  VALUES (p_partner_id, p_amount, 'cash_in', 'wallet_transfer', 'proxy_agent_assignments', v_tracking_id,
    format('Deposit from agent %s — %s', v_agent_name, COALESCE(p_notes, v_tracking_id)),
    'wallet', v_txn_group, 'UGX', p_agent_id);

  -- 3. Update wallet balances
  UPDATE wallets SET balance = balance - p_amount, updated_at = NOW() WHERE user_id = p_agent_id;
  
  -- Ensure partner has a wallet
  INSERT INTO wallets (user_id, balance, currency)
  VALUES (p_partner_id, 0, 'UGX')
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE wallets SET balance = balance + p_amount, updated_at = NOW() WHERE user_id = p_partner_id;

  -- Get updated balances
  SELECT balance INTO v_agent_balance FROM wallets WHERE user_id = p_agent_id;
  SELECT balance INTO v_partner_balance FROM wallets WHERE user_id = p_partner_id;

  RETURN jsonb_build_object(
    'success', true,
    'amount', p_amount,
    'tracking_id', v_tracking_id,
    'agent_balance_after', v_agent_balance,
    'partner_balance_after', v_partner_balance,
    'partner_name', v_partner_name,
    'txn_group_id', v_txn_group
  );
END;
$$;
