
CREATE OR REPLACE FUNCTION public.credit_agent_rent_commission(
  p_rent_request_id uuid,
  p_repayment_amount numeric,
  p_source_table text DEFAULT 'rent_requests'::text,
  p_source_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_agent_id UUID;
  v_tenant_id UUID;
  v_parent_agent_id UUID;
  v_commission NUMERIC := 10000; -- flat UGX 10,000
  v_parent_commission NUMERIC;
  v_is_sub_agent BOOLEAN := FALSE;
  v_effective_source_id UUID;
  v_txn_group_id UUID;
BEGIN
  v_effective_source_id := COALESCE(p_source_id, p_rent_request_id);

  SELECT COALESCE(assigned_agent_id, agent_id), tenant_id
  INTO v_agent_id, v_tenant_id
  FROM rent_requests
  WHERE id = p_rent_request_id;

  IF v_agent_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_agent');
  END IF;

  -- Check if sub-agent → 8,000 to sub-agent + 2,000 to parent
  SELECT sa.parent_agent_id INTO v_parent_agent_id
  FROM agent_subagents sa
  WHERE sa.sub_agent_id = v_agent_id;

  IF v_parent_agent_id IS NOT NULL THEN
    v_is_sub_agent := TRUE;
    v_commission := 8000; -- sub-agent gets 8,000
  END IF;

  -- IDEMPOTENCY GUARD
  IF EXISTS (
    SELECT 1 FROM general_ledger
    WHERE category = 'agent_commission'
      AND source_id = v_effective_source_id
      AND user_id = v_agent_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'already_credited');
  END IF;

  -- Record in agent_earnings
  INSERT INTO agent_earnings (agent_id, amount, earning_type, source_user_id, rent_request_id, description)
  VALUES (
    v_agent_id, v_commission, 'commission', v_tenant_id, p_rent_request_id,
    'UGX ' || TRIM(TO_CHAR(v_commission, '999,999,999')) || ' flat commission on tenant deposit'
  );

  v_txn_group_id := gen_random_uuid();

  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, linked_party, transaction_date, ledger_scope, transaction_group_id)
  VALUES (
    v_agent_id, v_commission, 'cash_in', 'agent_commission',
    p_source_table, v_effective_source_id,
    'UGX ' || TRIM(TO_CHAR(v_commission, '999,999,999')) || ' flat commission on tenant deposit',
    v_tenant_id::TEXT, NOW(), 'wallet', v_txn_group_id
  );

  -- Sub-agent: credit parent 2,000 override
  IF v_is_sub_agent AND v_parent_agent_id IS NOT NULL THEN
    v_parent_commission := 2000;

    IF NOT EXISTS (
      SELECT 1 FROM general_ledger
      WHERE category = 'agent_commission'
        AND source_id = v_effective_source_id
        AND user_id = v_parent_agent_id
    ) THEN
      INSERT INTO agent_earnings (agent_id, amount, earning_type, source_user_id, rent_request_id, description)
      VALUES (
        v_parent_agent_id, v_parent_commission, 'subagent_commission', v_tenant_id, p_rent_request_id,
        'UGX 2,000 override from sub-agent tenant deposit'
      );

      INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, linked_party, transaction_date, ledger_scope, transaction_group_id)
      VALUES (
        v_parent_agent_id, v_parent_commission, 'cash_in', 'agent_commission',
        p_source_table, v_effective_source_id,
        'UGX 2,000 override from sub-agent tenant deposit',
        'platform', NOW(), 'wallet', v_txn_group_id
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'agent_id', v_agent_id,
    'commission', v_commission,
    'is_sub_agent', v_is_sub_agent,
    'parent_agent_id', v_parent_agent_id,
    'parent_commission', COALESCE(v_parent_commission, 0)
  );
END;
$function$;
