
CREATE OR REPLACE FUNCTION public.credit_agent_rent_commission(
  p_rent_request_id uuid,
  p_repayment_amount numeric,
  p_tenant_id uuid,
  p_event_reference_id text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_source_agent_id  uuid;
  v_manager_agent_id uuid;
  v_recruiter_id     uuid;
  v_total_commission numeric;
  v_source_amount    numeric;
  v_manager_amount   numeric;
  v_recruiter_amount numeric;
  v_same_agent       boolean;
  v_credited         numeric := 0;
  v_result           jsonb := '[]'::jsonb;
  v_txn_group        uuid;
  v_idem_key         text;
BEGIN
  v_idem_key         := COALESCE(p_event_reference_id, p_rent_request_id::text);
  v_total_commission := round(p_repayment_amount * 0.10);

  SELECT agent_id, assigned_agent_id
    INTO v_source_agent_id, v_manager_agent_id
    FROM rent_requests WHERE id = p_rent_request_id;

  IF v_manager_agent_id IS NULL THEN v_manager_agent_id := v_source_agent_id; END IF;
  IF v_source_agent_id IS NULL AND v_manager_agent_id IS NULL THEN
    RETURN jsonb_build_object('status','no_agents','total_commission',0,'credited_commission',0);
  END IF;

  v_same_agent := (v_source_agent_id = v_manager_agent_id);

  -- Only an ACCEPTED sub-agent link earns the recruiter an override. Pending,
  -- expired, rejected or released links pay nothing to the recruiter.
  SELECT parent_agent_id INTO v_recruiter_id
    FROM agent_subagents
   WHERE sub_agent_id = v_manager_agent_id
     AND status = 'verified'
   ORDER BY created_at ASC
   LIMIT 1;

  IF v_same_agent THEN
    IF v_recruiter_id IS NOT NULL AND v_recruiter_id <> v_source_agent_id THEN
      v_manager_amount   := round(p_repayment_amount * 0.08);
      v_recruiter_amount := v_total_commission - v_manager_amount;
      v_source_amount    := 0;
    ELSE
      v_manager_amount   := v_total_commission;
      v_recruiter_amount := 0;
      v_source_amount    := 0;
    END IF;
  ELSE
    v_source_amount := round(p_repayment_amount * 0.02);
    IF v_recruiter_id IS NOT NULL AND v_recruiter_id <> v_source_agent_id AND v_recruiter_id <> v_manager_agent_id THEN
      v_recruiter_amount := round(p_repayment_amount * 0.02);
      v_manager_amount   := v_total_commission - v_source_amount - v_recruiter_amount;
    ELSE
      v_recruiter_amount := 0;
      v_manager_amount   := v_total_commission - v_source_amount;
    END IF;
  END IF;

  IF v_source_amount > 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM commission_accrual_ledger
       WHERE source_id = v_idem_key AND agent_id = v_source_agent_id
         AND commission_role = 'source_agent' AND event_type = 'repayment'
    ) THEN
      v_txn_group := gen_random_uuid();
      PERFORM public.create_ledger_transaction(
        'agent_rent_commission_source',
        jsonb_build_array(
          jsonb_build_object(
            'user_id', v_source_agent_id, 'amount', v_source_amount,
            'direction', 'cash_in', 'category', 'agent_commission_earned',
            'ledger_scope', 'wallet', 'classification','production',
            'description', 'Onboarding commission (2%) on repayment',
            'source_table', 'commission_engine', 'source_id', p_rent_request_id::text,
            'reference_id', v_txn_group::text, 'recipient_type', 'user'
          ),
          jsonb_build_object(
            'user_id', v_source_agent_id, 'amount', v_source_amount,
            'direction', 'cash_out', 'category', 'marketing_expense',
            'ledger_scope', 'platform', 'classification','production',
            'description', 'Marketing expense: Source agent 2% commission',
            'source_table', 'commission_engine', 'source_id', p_rent_request_id::text,
            'reference_id', v_txn_group::text
          )
        )
      );
      INSERT INTO commission_accrual_ledger (agent_id, tenant_id, amount, percentage, event_type, commission_role, source_type, source_id, rent_request_id, repayment_amount, status, description)
      VALUES (v_source_agent_id, p_tenant_id, v_source_amount, 2, 'repayment', 'source_agent', 'repayment', v_idem_key, p_rent_request_id, p_repayment_amount, 'earned', 'Source agent 2% commission');
      v_credited := v_credited + v_source_amount;
      v_result := v_result || jsonb_build_object('source_agent', v_source_agent_id, 'source_amount', v_source_amount);
    END IF;
  END IF;

  IF v_manager_amount > 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM commission_accrual_ledger
       WHERE source_id = v_idem_key AND agent_id = v_manager_agent_id
         AND commission_role = 'tenant_manager' AND event_type = 'repayment'
    ) THEN
      v_txn_group := gen_random_uuid();
      PERFORM public.create_ledger_transaction(
        'agent_rent_commission_manager',
        jsonb_build_array(
          jsonb_build_object(
            'user_id', v_manager_agent_id, 'amount', v_manager_amount,
            'direction', 'cash_in', 'category', 'agent_commission_earned',
            'ledger_scope', 'wallet', 'classification','production',
            'description', 'Manager commission on repayment',
            'source_table', 'commission_engine', 'source_id', p_rent_request_id::text,
            'reference_id', v_txn_group::text, 'recipient_type', 'user'
          ),
          jsonb_build_object(
            'user_id', v_manager_agent_id, 'amount', v_manager_amount,
            'direction', 'cash_out', 'category', 'marketing_expense',
            'ledger_scope', 'platform', 'classification','production',
            'description', 'Marketing expense: Manager agent commission',
            'source_table', 'commission_engine', 'source_id', p_rent_request_id::text,
            'reference_id', v_txn_group::text
          )
        )
      );
      INSERT INTO commission_accrual_ledger (agent_id, tenant_id, amount, percentage, event_type, commission_role, source_type, source_id, rent_request_id, repayment_amount, status, description)
      VALUES (v_manager_agent_id, p_tenant_id, v_manager_amount, 8, 'repayment', 'tenant_manager', 'repayment', v_idem_key, p_rent_request_id, p_repayment_amount, 'earned', 'Manager agent commission');
      v_credited := v_credited + v_manager_amount;
      v_result := v_result || jsonb_build_object('manager_agent', v_manager_agent_id, 'manager_amount', v_manager_amount);
    END IF;
  END IF;

  IF v_recruiter_amount > 0 AND v_recruiter_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM commission_accrual_ledger
       WHERE source_id = v_idem_key AND agent_id = v_recruiter_id
         AND commission_role = 'recruiter' AND event_type = 'repayment'
    ) THEN
      v_txn_group := gen_random_uuid();
      PERFORM public.create_ledger_transaction(
        'agent_rent_commission_recruiter',
        jsonb_build_array(
          jsonb_build_object(
            'user_id', v_recruiter_id, 'amount', v_recruiter_amount,
            'direction', 'cash_in', 'category', 'agent_commission_earned',
            'ledger_scope', 'wallet', 'classification','production',
            'description', 'Recruiter commission on repayment',
            'source_table', 'commission_engine', 'source_id', p_rent_request_id::text,
            'reference_id', v_txn_group::text, 'recipient_type', 'user'
          ),
          jsonb_build_object(
            'user_id', v_recruiter_id, 'amount', v_recruiter_amount,
            'direction', 'cash_out', 'category', 'marketing_expense',
            'ledger_scope', 'platform', 'classification','production',
            'description', 'Marketing expense: Recruiter agent commission',
            'source_table', 'commission_engine', 'source_id', p_rent_request_id::text,
            'reference_id', v_txn_group::text
          )
        )
      );
      INSERT INTO commission_accrual_ledger (agent_id, tenant_id, amount, percentage, event_type, commission_role, source_type, source_id, rent_request_id, repayment_amount, status, description)
      VALUES (v_recruiter_id, p_tenant_id, v_recruiter_amount, 2, 'repayment', 'recruiter', 'repayment', v_idem_key, p_rent_request_id, p_repayment_amount, 'earned', 'Recruiter agent commission');
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
$function$;


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
  SELECT COALESCE(assigned_agent_id, agent_id), tenant_id
  INTO v_agent_id, v_tenant_id
  FROM rent_requests
  WHERE id = p_rent_request_id;

  IF v_agent_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_agent');
  END IF;

  -- Only an ACCEPTED (verified) parent link makes the collector a sub-agent.
  SELECT sa.parent_agent_id INTO v_direct_parent
  FROM agent_subagents sa
  WHERE sa.sub_agent_id = v_agent_id
    AND sa.status = 'verified'
  ORDER BY sa.created_at ASC
  LIMIT 1;

  IF v_direct_parent IS NOT NULL THEN
    v_is_sub_agent := TRUE;
    v_commission_rate := 0.04;
  END IF;

  v_commission := ROUND(p_repayment_amount * v_commission_rate);

  IF v_commission <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'zero_commission');
  END IF;

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

  v_current_child := v_agent_id;

  WHILE v_depth < v_max_depth LOOP
    -- Only walk ACCEPTED (verified) upline links.
    SELECT sa.parent_agent_id INTO v_current_parent
    FROM agent_subagents sa
    WHERE sa.sub_agent_id = v_current_child
      AND sa.status = 'verified'
    ORDER BY sa.created_at ASC
    LIMIT 1;

    EXIT WHEN v_current_parent IS NULL;
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
$function$;
