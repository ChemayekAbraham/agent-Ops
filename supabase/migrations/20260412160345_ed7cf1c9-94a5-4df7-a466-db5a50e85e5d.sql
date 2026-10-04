
-- Update credit_agent_rent_commission to insert as 'paid' instead of 'earned'
CREATE OR REPLACE FUNCTION public.credit_agent_rent_commission(
  p_rent_request_id UUID,
  p_tenant_id UUID,
  p_repayment_amount NUMERIC,
  p_event_reference_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source_agent_id UUID;
  v_manager_agent_id UUID;
  v_recruiter_id UUID;
  v_total_commission NUMERIC;
  v_source_amount NUMERIC;
  v_manager_amount NUMERIC;
  v_recruiter_amount NUMERIC;
  v_same_agent BOOLEAN;
  v_credited NUMERIC := 0;
  v_result JSONB := '[]'::JSONB;
  v_txn_group UUID := gen_random_uuid();
  v_idem_key TEXT;
  v_now TIMESTAMPTZ := now();
BEGIN
  v_idem_key := COALESCE(p_event_reference_id, p_rent_request_id::TEXT);
  v_total_commission := ROUND(p_repayment_amount * 0.10);

  SELECT agent_id, assigned_agent_id
  INTO v_source_agent_id, v_manager_agent_id
  FROM rent_requests WHERE id = p_rent_request_id;

  IF v_manager_agent_id IS NULL THEN v_manager_agent_id := v_source_agent_id; END IF;
  IF v_source_agent_id IS NULL AND v_manager_agent_id IS NULL THEN
    RETURN jsonb_build_object('status','no_agents','total_commission',0,'credited_commission',0);
  END IF;

  v_same_agent := (v_source_agent_id = v_manager_agent_id);

  SELECT parent_agent_id INTO v_recruiter_id
  FROM agent_subagents WHERE sub_agent_id = v_manager_agent_id LIMIT 1;

  IF v_same_agent THEN
    IF v_recruiter_id IS NOT NULL AND v_recruiter_id != v_source_agent_id THEN
      v_manager_amount := ROUND(p_repayment_amount * 0.08);
      v_recruiter_amount := v_total_commission - v_manager_amount;
      v_source_amount := 0;
    ELSE
      v_manager_amount := v_total_commission;
      v_recruiter_amount := 0;
      v_source_amount := 0;
    END IF;
  ELSE
    v_source_amount := ROUND(p_repayment_amount * 0.02);
    IF v_recruiter_id IS NOT NULL AND v_recruiter_id != v_source_agent_id AND v_recruiter_id != v_manager_agent_id THEN
      v_recruiter_amount := ROUND(p_repayment_amount * 0.02);
      v_manager_amount := v_total_commission - v_source_amount - v_recruiter_amount;
    ELSE
      v_recruiter_amount := 0;
      v_manager_amount := v_total_commission - v_source_amount;
    END IF;
  END IF;

  -- Credit source agent
  IF v_source_amount > 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM commission_accrual_ledger
      WHERE source_id = v_idem_key AND agent_id = v_source_agent_id AND commission_role = 'source_agent' AND event_type = 'repayment'
    ) THEN
      INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
      VALUES (v_source_agent_id, v_source_amount, 'cash_out', 'marketing_expense', 'commission_engine', p_rent_request_id,
        'Marketing expense: Source agent 2% commission', 'platform', v_txn_group);
      INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
      VALUES (v_source_agent_id, v_source_amount, 'cash_in', 'agent_commission', 'commission_engine', p_rent_request_id,
        'Onboarding commission (2%) on repayment', 'wallet', v_txn_group);
      INSERT INTO commission_accrual_ledger (agent_id, tenant_id, amount, percentage, event_type, commission_role, source_type, source_id, rent_request_id, repayment_amount, status, description, approved_at, paid_at)
      VALUES (v_source_agent_id, p_tenant_id, v_source_amount, 2, 'repayment', 'source_agent', 'repayment', v_idem_key, p_rent_request_id, p_repayment_amount, 'paid', 'Source agent 2% commission', v_now, v_now);
      v_credited := v_credited + v_source_amount;
      v_result := v_result || jsonb_build_object('source_agent', v_source_agent_id, 'source_amount', v_source_amount);
    END IF;
  END IF;

  -- Credit manager agent
  IF v_manager_amount > 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM commission_accrual_ledger
      WHERE source_id = v_idem_key AND agent_id = v_manager_agent_id AND commission_role = 'tenant_manager' AND event_type = 'repayment'
    ) THEN
      INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
      VALUES (v_manager_agent_id, v_manager_amount, 'cash_out', 'marketing_expense', 'commission_engine', p_rent_request_id,
        'Marketing expense: Manager agent commission', 'platform', v_txn_group);
      INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
      VALUES (v_manager_agent_id, v_manager_amount, 'cash_in', 'agent_commission', 'commission_engine', p_rent_request_id,
        'Manager commission on repayment', 'wallet', v_txn_group);
      INSERT INTO commission_accrual_ledger (agent_id, tenant_id, amount, percentage, event_type, commission_role, source_type, source_id, rent_request_id, repayment_amount, status, description, approved_at, paid_at)
      VALUES (v_manager_agent_id, p_tenant_id, v_manager_amount, 8, 'repayment', 'tenant_manager', 'repayment', v_idem_key, p_rent_request_id, p_repayment_amount, 'paid', 'Manager agent commission', v_now, v_now);
      v_credited := v_credited + v_manager_amount;
      v_result := v_result || jsonb_build_object('manager_agent', v_manager_agent_id, 'manager_amount', v_manager_amount);
    END IF;
  END IF;

  -- Credit recruiter
  IF v_recruiter_amount > 0 AND v_recruiter_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM commission_accrual_ledger
      WHERE source_id = v_idem_key AND agent_id = v_recruiter_id AND commission_role = 'recruiter' AND event_type = 'repayment'
    ) THEN
      INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
      VALUES (v_recruiter_id, v_recruiter_amount, 'cash_out', 'marketing_expense', 'commission_engine', p_rent_request_id,
        'Marketing expense: Recruiter agent commission', 'platform', v_txn_group);
      INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
      VALUES (v_recruiter_id, v_recruiter_amount, 'cash_in', 'agent_commission', 'commission_engine', p_rent_request_id,
        'Recruiter commission on repayment', 'wallet', v_txn_group);
      INSERT INTO commission_accrual_ledger (agent_id, tenant_id, amount, percentage, event_type, commission_role, source_type, source_id, rent_request_id, repayment_amount, status, description, approved_at, paid_at)
      VALUES (v_recruiter_id, p_tenant_id, v_recruiter_amount, 2, 'repayment', 'recruiter', 'repayment', v_idem_key, p_rent_request_id, p_repayment_amount, 'paid', 'Recruiter agent commission', v_now, v_now);
      v_credited := v_credited + v_recruiter_amount;
      v_result := v_result || jsonb_build_object('recruiter', v_recruiter_id, 'recruiter_amount', v_recruiter_amount);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_credited > 0 THEN 'credited' ELSE 'already_credited' END,
    'total_commission', v_total_commission,
    'credited_commission', v_credited,
    'splits', v_result
  );
END;
$$;

-- Update credit_agent_event_bonus to insert as 'paid' instead of 'earned'
CREATE OR REPLACE FUNCTION public.credit_agent_event_bonus(
  p_agent_id UUID,
  p_event_type TEXT,
  p_tenant_id UUID,
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
  v_now TIMESTAMPTZ := now();
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

  INSERT INTO commission_accrual_ledger (agent_id, tenant_id, amount, percentage, event_type, commission_role, source_type, source_id, status, description, approved_at, paid_at)
  VALUES (p_agent_id, p_tenant_id, v_amount, NULL, p_event_type, 'event_bonus', p_event_type, p_source_id, 'paid', v_description, v_now, v_now);

  RETURN jsonb_build_object('status', 'ok', 'amount', v_amount, 'event_type', p_event_type);
END;
$$;

-- Also update any existing 'earned' or 'approved' entries to 'paid' since money already hit wallets
UPDATE commission_accrual_ledger 
SET status = 'paid', 
    approved_at = COALESCE(approved_at, now()), 
    paid_at = COALESCE(paid_at, now())
WHERE status IN ('earned', 'approved');
