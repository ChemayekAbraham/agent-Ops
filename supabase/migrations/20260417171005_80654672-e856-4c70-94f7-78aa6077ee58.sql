
-- Fix 1: Rewrite credit_agent_event_bonus to use create_ledger_transaction (ledger fortress compliant)
CREATE OR REPLACE FUNCTION public.credit_agent_event_bonus(
  p_agent_id uuid,
  p_event_type text,
  p_tenant_id uuid,
  p_source_id text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_amount NUMERIC;
  v_description TEXT;
  v_now TIMESTAMPTZ := now();
  v_idempotency_key TEXT;
  v_group_id UUID;
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

  -- Idempotency: don't double-credit the same source
  IF p_source_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM commission_accrual_ledger
    WHERE source_id = p_source_id AND agent_id = p_agent_id AND event_type = p_event_type
  ) THEN
    RETURN jsonb_build_object('status', 'already_credited');
  END IF;

  v_idempotency_key := 'event_bonus:' || p_event_type || ':' || p_agent_id::text || ':' || COALESCE(p_source_id, gen_random_uuid()::text);

  -- Use canonical ledger RPC: balanced double-entry
  -- Leg 1: marketing_expense (platform cash_out)
  -- Leg 2: agent_commission (wallet cash_in to agent)
  v_group_id := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', p_agent_id,
        'amount', v_amount,
        'direction', 'cash_out',
        'category', 'marketing_expense',
        'source_table', 'commission_engine',
        'source_id', COALESCE(p_source_id, gen_random_uuid()::text),
        'description', 'Marketing expense: ' || v_description,
        'ledger_scope', 'platform'
      ),
      jsonb_build_object(
        'user_id', p_agent_id,
        'amount', v_amount,
        'direction', 'cash_in',
        'category', 'agent_commission',
        'source_table', 'commission_engine',
        'source_id', COALESCE(p_source_id, gen_random_uuid()::text),
        'description', v_description,
        'ledger_scope', 'wallet'
      )
    ),
    v_idempotency_key,
    true  -- skip balance check (this is a credit, not a debit from balance)
  );

  -- Record in commission accrual ledger
  INSERT INTO commission_accrual_ledger (
    agent_id, tenant_id, amount, percentage, event_type, commission_role,
    source_type, source_id, status, description, approved_at, paid_at
  )
  VALUES (
    p_agent_id, p_tenant_id, v_amount, NULL, p_event_type, 'event_bonus',
    p_event_type, p_source_id, 'paid', v_description, v_now, v_now
  );

  RETURN jsonb_build_object(
    'status', 'ok',
    'amount', v_amount,
    'event_type', p_event_type,
    'transaction_group_id', v_group_id
  );
END;
$function$;

-- Fix 2: Correct argument order in trigger function
-- Signature is (p_agent_id, p_event_type, p_tenant_id, p_source_id)
CREATE OR REPLACE FUNCTION public.award_subagent_registration_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_result JSONB;
BEGIN
  -- Only fire when status transitions TO 'verified'
  IF NEW.status = 'verified' AND (OLD.status IS DISTINCT FROM 'verified') THEN
    SELECT public.credit_agent_event_bonus(
      NEW.parent_agent_id,           -- p_agent_id
      'subagent_registration',        -- p_event_type
      NULL::UUID,                     -- p_tenant_id (not applicable)
      NEW.sub_agent_id::TEXT          -- p_source_id (for idempotency)
    ) INTO v_result;

    RAISE LOG '[award_subagent_registration_bonus] parent=% sub=% result=%',
      NEW.parent_agent_id, NEW.sub_agent_id, v_result;
  END IF;

  RETURN NEW;
END;
$function$;
