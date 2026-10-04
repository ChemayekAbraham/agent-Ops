
CREATE OR REPLACE FUNCTION public.credit_agent_event_bonus(
  p_agent_id UUID,
  p_tenant_id UUID,
  p_event_type TEXT,
  p_source_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_amount NUMERIC;
  v_description TEXT;
  v_txn_group UUID := gen_random_uuid();
BEGIN
  v_amount := CASE p_event_type
    WHEN 'rent_request_posted' THEN 5000
    WHEN 'house_listed' THEN 5000
    WHEN 'tenant_replacement' THEN 20000
    WHEN 'subagent_registration' THEN 10000
    WHEN 'service_centre_setup' THEN 25000
    ELSE NULL
  END;

  IF v_amount IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'Unknown event_type: ' || p_event_type);
  END IF;

  v_description := CASE p_event_type
    WHEN 'rent_request_posted' THEN 'Bonus: Rent request posted'
    WHEN 'house_listed' THEN 'Bonus: Empty house listed'
    WHEN 'tenant_replacement' THEN 'Bonus: Tenant replacement'
    WHEN 'subagent_registration' THEN 'Bonus: Sub-agent registration'
    WHEN 'service_centre_setup' THEN 'Bonus: Service Centre setup'
  END;

  IF p_source_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM commission_accrual_ledger
    WHERE source_id = p_source_id AND agent_id = p_agent_id AND event_type = p_event_type
  ) THEN
    RETURN jsonb_build_object('status', 'already_credited');
  END IF;

  -- Platform marketing expense (cash_out)
  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
  VALUES (p_agent_id, v_amount, 'cash_out', 'marketing_expense', 'commission_engine', COALESCE(p_source_id::UUID, gen_random_uuid()),
    'Marketing expense: ' || v_description, 'platform', v_txn_group);

  -- Agent wallet credit (cash_in)
  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
  VALUES (p_agent_id, v_amount, 'cash_in', 'agent_commission', 'commission_engine', COALESCE(p_source_id::UUID, gen_random_uuid()),
    v_description, 'wallet', v_txn_group);

  INSERT INTO commission_accrual_ledger (agent_id, tenant_id, amount, percentage, event_type, commission_role, source_type, source_id, status, description)
  VALUES (p_agent_id, p_tenant_id, v_amount, NULL, p_event_type, 'event_bonus', p_event_type, p_source_id, 'earned', v_description);

  RETURN jsonb_build_object('status', 'ok', 'amount', v_amount, 'event_type', p_event_type);
END;
$$;
