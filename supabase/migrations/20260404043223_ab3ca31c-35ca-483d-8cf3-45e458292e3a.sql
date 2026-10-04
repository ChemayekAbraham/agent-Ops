
-- Replace credit_agent_rent_commission: fix idempotency to be per-event, not per-rent-request
-- Add p_event_reference_id parameter for unique payment-level idempotency
DROP FUNCTION IF EXISTS public.credit_agent_rent_commission(uuid, numeric, uuid);

CREATE OR REPLACE FUNCTION public.credit_agent_rent_commission(
  p_rent_request_id UUID,
  p_repayment_amount NUMERIC,
  p_tenant_id UUID,
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
BEGIN
  -- Use event reference for idempotency; fall back to rent_request_id if not provided
  v_idem_key := COALESCE(p_event_reference_id, p_rent_request_id::TEXT);

  v_total_commission := ROUND(p_repayment_amount * 0.10);

  SELECT agent_id, assigned_agent_id
  INTO v_source_agent_id, v_manager_agent_id
  FROM rent_requests
  WHERE id = p_rent_request_id;

  IF v_manager_agent_id IS NULL THEN
    v_manager_agent_id := v_source_agent_id;
  END IF;

  IF v_source_agent_id IS NULL AND v_manager_agent_id IS NULL THEN
    RETURN jsonb_build_object('status', 'no_agents', 'total_commission', 0, 'credited_commission', 0);
  END IF;

  v_same_agent := (v_source_agent_id = v_manager_agent_id);

  SELECT parent_agent_id INTO v_recruiter_id
  FROM agent_subagents
  WHERE sub_agent_id = v_manager_agent_id
  LIMIT 1;

  -- Calculate splits (same logic as before)
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

  -- ═══ Credit source agent ═══
  IF v_source_amount > 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM commission_accrual_ledger
      WHERE source_id = v_idem_key AND agent_id = v_source_agent_id AND commission_role = 'source_agent'
        AND event_type = 'repayment'
    ) THEN
      INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
      VALUES (v_source_agent_id, v_source_amount, 'cash_out', 'marketing_expense', 'commission_engine', p_rent_request_id,
        'Marketing expense: Source agent 2% commission', 'platform', v_txn_group);

      INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
      VALUES (v_source_agent_id, v_source_amount, 'cash_in', 'agent_commission', 'commission_engine', p_rent_request_id,
        'Onboarding commission (2%) on repayment', 'wallet', v_txn_group);

      INSERT INTO commission_accrual_ledger (agent_id, tenant_id, amount, percentage, event_type, commission_role, source_type, source_id, rent_request_id, repayment_amount, status, description)
      VALUES (v_source_agent_id, p_tenant_id, v_source_amount, 2, 'repayment', 'source_agent', 'repayment', v_idem_key, p_rent_request_id, p_repayment_amount, 'earned', 'Source agent 2% commission');

      v_credited := v_credited + v_source_amount;
      v_result := v_result || jsonb_build_object('source_agent', v_source_agent_id, 'source_amount', v_source_amount);
    END IF;
  END IF;

  -- ═══ Credit manager agent ═══
  IF v_manager_amount > 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM commission_accrual_ledger
      WHERE source_id = v_idem_key AND agent_id = v_manager_agent_id AND commission_role = 'tenant_manager'
        AND event_type = 'repayment'
    ) THEN
      INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
      VALUES (v_manager_agent_id, v_manager_amount, 'cash_out', 'marketing_expense', 'commission_engine', p_rent_request_id,
        'Marketing expense: Manager agent commission', 'platform', v_txn_group);

      INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
      VALUES (v_manager_agent_id, v_manager_amount, 'cash_in', 'agent_commission', 'commission_engine', p_rent_request_id,
        CASE WHEN v_same_agent THEN 'Full commission (10%) on repayment'
             WHEN v_recruiter_amount > 0 THEN 'Manager commission (6%) on repayment'
             ELSE 'Manager commission (8%) on repayment' END,
        'wallet', v_txn_group);

      INSERT INTO commission_accrual_ledger (agent_id, tenant_id, amount, percentage, event_type, commission_role, source_type, source_id, rent_request_id, repayment_amount, status, description)
      VALUES (v_manager_agent_id, p_tenant_id, v_manager_amount,
        CASE WHEN v_same_agent AND v_recruiter_amount = 0 THEN 10 WHEN v_recruiter_amount > 0 THEN 6 ELSE 8 END,
        'repayment', 'tenant_manager', 'repayment', v_idem_key, p_rent_request_id, p_repayment_amount, 'earned',
        CASE WHEN v_same_agent THEN 'Source+Manager commission' ELSE 'Manager commission' END);

      v_credited := v_credited + v_manager_amount;
      v_result := v_result || jsonb_build_object('manager_agent', v_manager_agent_id, 'manager_amount', v_manager_amount);
    END IF;
  END IF;

  -- ═══ Credit recruiter ═══
  IF v_recruiter_amount > 0 AND v_recruiter_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM commission_accrual_ledger
      WHERE source_id = v_idem_key AND agent_id = v_recruiter_id AND commission_role = 'recruiter_override'
        AND event_type = 'repayment'
    ) THEN
      INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
      VALUES (v_recruiter_id, v_recruiter_amount, 'cash_out', 'marketing_expense', 'commission_engine', p_rent_request_id,
        'Marketing expense: Recruiter override 2%', 'platform', v_txn_group);

      INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
      VALUES (v_recruiter_id, v_recruiter_amount, 'cash_in', 'agent_commission', 'commission_engine', p_rent_request_id,
        'Recruiter override (2%) on repayment', 'wallet', v_txn_group);

      INSERT INTO commission_accrual_ledger (agent_id, tenant_id, amount, percentage, event_type, commission_role, source_type, source_id, rent_request_id, repayment_amount, status, description)
      VALUES (v_recruiter_id, p_tenant_id, v_recruiter_amount, 2, 'repayment', 'recruiter_override', 'repayment', v_idem_key, p_rent_request_id, p_repayment_amount, 'earned', 'Recruiter override 2% commission');

      v_credited := v_credited + v_recruiter_amount;
      v_result := v_result || jsonb_build_object('recruiter', v_recruiter_id, 'recruiter_amount', v_recruiter_amount);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_credited > 0 THEN 'ok' ELSE 'already_credited' END,
    'total_commission', v_total_commission,
    'credited_commission', v_credited,
    'splits', v_result
  );
END;
$$;
