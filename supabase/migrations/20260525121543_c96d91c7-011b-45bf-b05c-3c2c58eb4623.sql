
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
  v_direct_parent UUID;
  v_commission NUMERIC;
  v_override_amount NUMERIC;
  v_is_sub_agent BOOLEAN := FALSE;
  v_commission_rate NUMERIC := 0.05;
  v_current_child UUID;
  v_current_parent UUID;
  v_depth INT := 0;
  v_max_depth CONSTANT INT := 5;
  v_override_rate NUMERIC;
  v_overrides_paid JSONB := '[]'::jsonb;
BEGIN
  -- Get the assigned agent for this rent request
  SELECT COALESCE(assigned_agent_id, agent_id), tenant_id
  INTO v_agent_id, v_tenant_id
  FROM rent_requests
  WHERE id = p_rent_request_id;

  IF v_agent_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_agent');
  END IF;

  -- Determine if collecting agent is a sub-agent (has a parent)
  SELECT sa.parent_agent_id INTO v_direct_parent
  FROM agent_subagents sa
  WHERE sa.sub_agent_id = v_agent_id
  LIMIT 1;

  IF v_direct_parent IS NOT NULL THEN
    v_is_sub_agent := TRUE;
    v_commission_rate := 0.04;
  END IF;

  v_commission := ROUND(p_repayment_amount * v_commission_rate);

  IF v_commission <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'zero_commission');
  END IF;

  -- Record collecting agent's commission
  INSERT INTO agent_earnings (agent_id, amount, earning_type, source_user_id, rent_request_id, description)
  VALUES (
    v_agent_id, v_commission, 'commission', v_tenant_id, p_rent_request_id,
    (v_commission_rate * 100)::TEXT || '% commission on UGX ' || TRIM(TO_CHAR(p_repayment_amount, '999,999,999')) || ' rent repayment'
  );

  INSERT INTO wallets (user_id, balance, updated_at)
  VALUES (v_agent_id, v_commission, NOW())
  ON CONFLICT (user_id) DO UPDATE
  SET balance = wallets.balance + v_commission, updated_at = NOW();

  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, linked_party, transaction_date, ledger_scope)
  VALUES (
    v_agent_id, v_commission, 'cash_in', 'agent_commission',
    p_source_table, COALESCE(p_source_id, p_rent_request_id),
    (v_commission_rate * 100)::TEXT || '% auto-commission on tenant rent repayment',
    v_tenant_id::TEXT, NOW(), 'wallet'
  );

  INSERT INTO notifications (user_id, title, message, type, metadata)
  VALUES (
    v_agent_id, 'Commission Earned! 💰',
    'You earned UGX ' || TRIM(TO_CHAR(v_commission, '999,999,999')) || ' (' || (v_commission_rate * 100)::TEXT || '%) from rent repayment. Credited automatically.',
    'earning',
    jsonb_build_object('amount', v_commission, 'type', 'commission', 'rent_request_id', p_rent_request_id)
  );

  -- Walk up the recruitment chain and pay each ancestor an override.
  -- Rates by depth: L1 = 1%, L2 = 0.5%, L3 = 0.25%, L4 = 0.1%, L5 = 0.05%.
  v_current_child := v_agent_id;

  WHILE v_depth < v_max_depth LOOP
    SELECT sa.parent_agent_id INTO v_current_parent
    FROM agent_subagents sa
    WHERE sa.sub_agent_id = v_current_child
    LIMIT 1;

    EXIT WHEN v_current_parent IS NULL;
    -- Cycle guard
    EXIT WHEN v_current_parent = v_agent_id;

    v_depth := v_depth + 1;

    v_override_rate := CASE v_depth
      WHEN 1 THEN 0.01
      WHEN 2 THEN 0.005
      WHEN 3 THEN 0.0025
      WHEN 4 THEN 0.001
      WHEN 5 THEN 0.0005
      ELSE 0
    END;

    v_override_amount := ROUND(p_repayment_amount * v_override_rate);

    IF v_override_amount > 0 THEN
      INSERT INTO agent_earnings (agent_id, amount, earning_type, source_user_id, rent_request_id, description)
      VALUES (
        v_current_parent, v_override_amount, 'subagent_commission', v_tenant_id, p_rent_request_id,
        (v_override_rate * 100)::TEXT || '% L' || v_depth || ' override from sub-agent tenant repayment of UGX ' || TRIM(TO_CHAR(p_repayment_amount, '999,999,999'))
      );

      INSERT INTO wallets (user_id, balance, updated_at)
      VALUES (v_current_parent, v_override_amount, NOW())
      ON CONFLICT (user_id) DO UPDATE
      SET balance = wallets.balance + v_override_amount, updated_at = NOW();

      INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, linked_party, transaction_date, ledger_scope)
      VALUES (
        v_current_parent, v_override_amount, 'cash_in', 'agent_commission',
        p_source_table, COALESCE(p_source_id, p_rent_request_id),
        (v_override_rate * 100)::TEXT || '% L' || v_depth || ' override from downline tenant repayment',
        'platform', NOW(), 'wallet'
      );

      INSERT INTO notifications (user_id, title, message, type)
      VALUES (
        v_current_parent,
        CASE WHEN v_depth = 1 THEN 'Sub-Agent Commission 💰' ELSE 'Downline Commission 💰' END,
        'You earned UGX ' || TRIM(TO_CHAR(v_override_amount, '999,999,999')) || ' (' || (v_override_rate * 100)::TEXT || '% L' || v_depth || ' override) from a downline sub-agent''s tenant repayment.',
        'earning'
      );

      v_overrides_paid := v_overrides_paid || jsonb_build_object(
        'level', v_depth,
        'parent_id', v_current_parent,
        'amount', v_override_amount,
        'rate', v_override_rate
      );
    END IF;

    v_current_child := v_current_parent;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'agent_id', v_agent_id,
    'commission', v_commission,
    'is_sub_agent', v_is_sub_agent,
    'overrides', v_overrides_paid
  );
END;
$$;
