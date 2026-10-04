
-- Fix 1: credit_agent_rent_commission — remove direct wallet writes, add transaction_group_id, add idempotency
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
  v_commission NUMERIC;
  v_parent_commission NUMERIC;
  v_is_sub_agent BOOLEAN := FALSE;
  v_commission_rate NUMERIC := 0.05;
  v_effective_source_id UUID;
  v_txn_group_id UUID;
BEGIN
  v_effective_source_id := COALESCE(p_source_id, p_rent_request_id);

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

  -- IDEMPOTENCY GUARD: skip if already credited for this source
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
    (v_commission_rate * 100)::TEXT || '% commission on UGX ' || TRIM(TO_CHAR(p_repayment_amount, '999,999,999')) || ' rent repayment'
  );

  -- Generate transaction_group_id so sync_wallet_from_ledger trigger credits wallet
  v_txn_group_id := gen_random_uuid();

  -- Record in general_ledger WITH transaction_group_id (trigger handles wallet credit)
  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, linked_party, transaction_date, ledger_scope, transaction_group_id)
  VALUES (
    v_agent_id, v_commission, 'cash_in', 'agent_commission',
    p_source_table, v_effective_source_id,
    (v_commission_rate * 100)::TEXT || '% auto-commission on tenant rent repayment',
    v_tenant_id::TEXT, NOW(), 'wallet', v_txn_group_id
  );

  -- Sub-agent: credit parent 1% override
  IF v_is_sub_agent AND v_parent_agent_id IS NOT NULL THEN
    v_parent_commission := ROUND(p_repayment_amount * 0.01);

    -- Idempotency guard for parent too
    IF NOT EXISTS (
      SELECT 1 FROM general_ledger
      WHERE category = 'agent_commission'
        AND source_id = v_effective_source_id
        AND user_id = v_parent_agent_id
    ) THEN
      INSERT INTO agent_earnings (agent_id, amount, earning_type, source_user_id, rent_request_id, description)
      VALUES (
        v_parent_agent_id, v_parent_commission, 'subagent_commission', v_tenant_id, p_rent_request_id,
        '1% override from sub-agent repayment of UGX ' || TRIM(TO_CHAR(p_repayment_amount, '999,999,999'))
      );

      -- Ledger entry with transaction_group_id (trigger handles wallet credit)
      INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, linked_party, transaction_date, ledger_scope, transaction_group_id)
      VALUES (
        v_parent_agent_id, v_parent_commission, 'cash_in', 'agent_commission',
        p_source_table, v_effective_source_id,
        '1% auto-override from sub-agent tenant repayment',
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

-- Fix 2: record_rent_request_repayment — accept optional transaction_group_id
CREATE OR REPLACE FUNCTION public.record_rent_request_repayment(
  p_tenant_id uuid,
  p_amount numeric,
  p_transaction_group_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_request_id uuid;
  v_total_repayment numeric;
  v_amount_repaid numeric;
  v_apply numeric;
  v_landlord_id uuid;
  v_landlord_name text;
BEGIN
  -- Find the tenant's active rent request (funded/disbursed/approved)
  SELECT rr.id, rr.total_repayment, rr.amount_repaid, rr.landlord_id, l.name
  INTO v_request_id, v_total_repayment, v_amount_repaid, v_landlord_id, v_landlord_name
  FROM public.rent_requests rr
  LEFT JOIN public.landlords l ON l.id = rr.landlord_id
  WHERE
    rr.tenant_id = p_tenant_id
    AND rr.status IN ('funded', 'disbursed', 'approved')
    AND rr.amount_repaid < rr.total_repayment
  ORDER BY rr.created_at DESC
  LIMIT 1;

  IF v_request_id IS NOT NULL THEN
    v_apply := LEAST(p_amount, v_total_repayment - v_amount_repaid);

    -- Update rent_requests amount_repaid
    UPDATE public.rent_requests
    SET
      amount_repaid = amount_repaid + v_apply,
      status = CASE WHEN (amount_repaid + v_apply) >= total_repayment THEN 'completed' ELSE status END,
      updated_at = now()
    WHERE id = v_request_id;

    -- Record the repayment
    INSERT INTO public.repayments (tenant_id, rent_request_id, amount)
    VALUES (p_tenant_id, v_request_id, v_apply);

    -- Also reduce landlord's rent_balance_due
    IF v_landlord_id IS NOT NULL THEN
      UPDATE public.landlords
      SET
        rent_balance_due = GREATEST(0, rent_balance_due - v_apply),
        rent_last_paid_at = now(),
        rent_last_paid_amount = v_apply
      WHERE id = v_landlord_id;
    END IF;

    -- Post ledger entry for the repayment (audit trail)
    -- If transaction_group_id provided, trigger will also handle wallet deduction
    INSERT INTO public.general_ledger (
      user_id, amount, direction, category, source_table, source_id,
      description, linked_party, reference_id, transaction_group_id
    ) VALUES (
      p_tenant_id,
      v_apply,
      'cash_in',
      'rent_repayment',
      'repayments',
      v_request_id,
      'Rent repayment - ' || COALESCE(v_landlord_name, 'landlord'),
      v_landlord_id::text,
      v_request_id::text,
      p_transaction_group_id
    );
  END IF;
END;
$function$;
