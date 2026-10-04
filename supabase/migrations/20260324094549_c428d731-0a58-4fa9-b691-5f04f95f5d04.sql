
-- Update the credit_agent_rent_commission RPC to handle 4%/1% sub-agent split
-- This is called from auto-charge-wallets edge function

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
  v_parent_agent_id UUID;
  v_commission NUMERIC;
  v_parent_commission NUMERIC;
  v_is_sub_agent BOOLEAN := FALSE;
  v_commission_rate NUMERIC := 0.05;
BEGIN
  -- Get the assigned agent for this rent request
  SELECT COALESCE(assigned_agent_id, agent_id), tenant_id
  INTO v_agent_id, v_tenant_id
  FROM rent_requests
  WHERE id = p_rent_request_id;

  IF v_agent_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_agent');
  END IF;

  -- Check if sub-agent → 4% to sub-agent + 1% to parent
  SELECT sa.parent_agent_id INTO v_parent_agent_id
  FROM agent_subagents sa
  WHERE sa.sub_agent_id = v_agent_id;

  IF v_parent_agent_id IS NOT NULL THEN
    v_is_sub_agent := TRUE;
    v_commission_rate := 0.04;
  END IF;

  v_commission := ROUND(p_repayment_amount * v_commission_rate);

  IF v_commission <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'zero_commission');
  END IF;

  -- Record in agent_earnings
  INSERT INTO agent_earnings (agent_id, amount, earning_type, source_user_id, rent_request_id, description)
  VALUES (
    v_agent_id, v_commission, 'commission', v_tenant_id, p_rent_request_id,
    (v_commission_rate * 100)::TEXT || '% commission on UGX ' || TRIM(TO_CHAR(p_repayment_amount, '999,999,999')) || ' rent repayment'
  );

  -- DIRECTLY credit agent wallet
  INSERT INTO wallets (user_id, balance, updated_at)
  VALUES (v_agent_id, v_commission, NOW())
  ON CONFLICT (user_id) DO UPDATE
  SET balance = wallets.balance + v_commission, updated_at = NOW();

  -- Record in general_ledger
  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, linked_party, transaction_date, ledger_scope)
  VALUES (
    v_agent_id, v_commission, 'cash_in', 'agent_commission',
    p_source_table, COALESCE(p_source_id, p_rent_request_id),
    (v_commission_rate * 100)::TEXT || '% auto-commission on tenant rent repayment',
    v_tenant_id::TEXT, NOW(), 'wallet'
  );

  -- Notify agent
  INSERT INTO notifications (user_id, title, message, type, metadata)
  VALUES (
    v_agent_id, 'Commission Earned! 💰',
    'You earned UGX ' || TRIM(TO_CHAR(v_commission, '999,999,999')) || ' (' || (v_commission_rate * 100)::TEXT || '%) from rent repayment. Credited automatically.',
    'earning',
    jsonb_build_object('amount', v_commission, 'type', 'commission', 'rent_request_id', p_rent_request_id)
  );

  -- Sub-agent: credit parent 1% override
  IF v_is_sub_agent AND v_parent_agent_id IS NOT NULL THEN
    v_parent_commission := ROUND(p_repayment_amount * 0.01);

    INSERT INTO agent_earnings (agent_id, amount, earning_type, source_user_id, rent_request_id, description)
    VALUES (
      v_parent_agent_id, v_parent_commission, 'subagent_commission', v_tenant_id, p_rent_request_id,
      '1% override from sub-agent repayment of UGX ' || TRIM(TO_CHAR(p_repayment_amount, '999,999,999'))
    );

    INSERT INTO wallets (user_id, balance, updated_at)
    VALUES (v_parent_agent_id, v_parent_commission, NOW())
    ON CONFLICT (user_id) DO UPDATE
    SET balance = wallets.balance + v_parent_commission, updated_at = NOW();

    INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, linked_party, transaction_date, ledger_scope)
    VALUES (
      v_parent_agent_id, v_parent_commission, 'cash_in', 'agent_commission',
      p_source_table, COALESCE(p_source_id, p_rent_request_id),
      '1% auto-override from sub-agent tenant repayment',
      'platform', NOW(), 'wallet'
    );

    INSERT INTO notifications (user_id, title, message, type)
    VALUES (
      v_parent_agent_id, 'Sub-Agent Commission 💰',
      'You earned UGX ' || TRIM(TO_CHAR(v_parent_commission, '999,999,999')) || ' (1% override) from your sub-agent''s tenant repayment.',
      'earning'
    );
  END IF;

  RETURN jsonb_build_object('success', true, 'agent_id', v_agent_id, 'commission', v_commission, 'is_sub_agent', v_is_sub_agent);
END;
$$;
