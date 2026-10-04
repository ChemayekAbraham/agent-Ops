
-- Create a reusable function to credit agent 5% commission on any rent repayment
-- Called from edge functions after any successful rent repayment recording
CREATE OR REPLACE FUNCTION public.credit_agent_rent_commission(
  p_rent_request_id UUID,
  p_repayment_amount NUMERIC,
  p_source_table TEXT DEFAULT 'rent_requests',
  p_source_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent_id UUID;
  v_tenant_id UUID;
  v_commission NUMERIC;
  v_agent_wallet_balance NUMERIC;
  v_result JSONB;
BEGIN
  -- Get the assigned agent (or original agent) for this rent request
  SELECT COALESCE(assigned_agent_id, agent_id), tenant_id
  INTO v_agent_id, v_tenant_id
  FROM rent_requests
  WHERE id = p_rent_request_id;

  IF v_agent_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_agent');
  END IF;

  -- Calculate 5% commission
  v_commission := ROUND(p_repayment_amount * 0.05);

  IF v_commission <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'zero_commission');
  END IF;

  -- Record in agent_earnings
  INSERT INTO agent_earnings (agent_id, amount, earning_type, source_user_id, rent_request_id, description)
  VALUES (
    v_agent_id,
    v_commission,
    'commission',
    v_tenant_id,
    p_rent_request_id,
    '5% commission on UGX ' || TRIM(TO_CHAR(p_repayment_amount, '999,999,999')) || ' rent repayment'
  );

  -- Credit agent wallet (upsert + update)
  INSERT INTO wallets (user_id, balance, updated_at)
  VALUES (v_agent_id, v_commission, NOW())
  ON CONFLICT (user_id) DO UPDATE
  SET balance = wallets.balance + v_commission, updated_at = NOW();

  -- Record in general_ledger
  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, linked_party, transaction_date, ledger_scope)
  VALUES (
    v_agent_id,
    v_commission,
    'cash_in',
    'agent_commission',
    p_source_table,
    COALESCE(p_source_id, p_rent_request_id),
    '5% commission on tenant rent repayment (UGX ' || TRIM(TO_CHAR(p_repayment_amount, '999,999,999')) || ')',
    v_tenant_id::TEXT,
    NOW(),
    'wallet'
  );

  -- Notify agent
  INSERT INTO notifications (user_id, title, message, type, metadata)
  VALUES (
    v_agent_id,
    'Commission Earned! 💰',
    'You earned UGX ' || TRIM(TO_CHAR(v_commission, '999,999,999')) || ' (5%) from tenant rent repayment of UGX ' || TRIM(TO_CHAR(p_repayment_amount, '999,999,999')) || '.',
    'earning',
    jsonb_build_object('amount', v_commission, 'type', 'commission', 'rent_request_id', p_rent_request_id)
  );

  RETURN jsonb_build_object('success', true, 'agent_id', v_agent_id, 'commission', v_commission);
END;
$$;
