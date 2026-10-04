-- 1. Track placement bonus payment on the listing
ALTER TABLE public.house_listings
  ADD COLUMN IF NOT EXISTS placement_bonus_paid_at timestamptz;

-- 2. Extend credit_agent_event_bonus to support 'tenant_placement' (5,000 UGX)
CREATE OR REPLACE FUNCTION public.credit_agent_event_bonus(
  p_agent_id uuid,
  p_event_type text,
  p_tenant_id uuid,
  p_source_id text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
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
    WHEN 'tenant_placement' THEN 5000
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
    WHEN 'tenant_placement' THEN 'Bonus: Tenant placed in empty house'
    WHEN 'subagent_registration' THEN 'Bonus: Sub-agent registration'
    WHEN 'service_centre_setup' THEN 'Bonus: Service Centre setup'
  END;

  -- Idempotency
  IF p_source_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM commission_accrual_ledger
    WHERE source_id = p_source_id AND agent_id = p_agent_id AND event_type = p_event_type
  ) THEN
    RETURN jsonb_build_object('status', 'already_credited');
  END IF;

  v_idempotency_key := 'event_bonus:' || p_event_type || ':' || p_agent_id::text || ':' || COALESCE(p_source_id, gen_random_uuid()::text);

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
        'ledger_scope', 'wallet',
        'recipient_type', 'user'
      )
    ),
    v_idempotency_key
  );

  -- Mirror into commission_accrual_ledger (for idempotency lookups)
  INSERT INTO commission_accrual_ledger (agent_id, event_type, amount, source_id, tenant_id, description, metadata)
  VALUES (
    p_agent_id, p_event_type, v_amount, p_source_id, p_tenant_id, v_description,
    jsonb_build_object('ledger_group_id', v_group_id)
  )
  ON CONFLICT DO NOTHING;

  -- Mirror into agent_incentive_bonuses (for agent-facing history)
  INSERT INTO agent_incentive_bonuses (agent_id, bonus_type, amount, description, metadata)
  VALUES (
    p_agent_id, p_event_type, v_amount, v_description,
    jsonb_build_object('source_id', p_source_id, 'tenant_id', p_tenant_id, 'ledger_group_id', v_group_id)
  );

  RETURN jsonb_build_object(
    'status', 'credited',
    'amount', v_amount,
    'event_type', p_event_type,
    'ledger_group_id', v_group_id
  );
END;
$function$;

-- 3. Trigger: when an empty house gets a tenant for the first time, pay the listing agent
CREATE OR REPLACE FUNCTION public.pay_tenant_placement_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_result jsonb;
BEGIN
  -- Only fire on transition from "no tenant" -> "has tenant"
  IF (TG_OP = 'UPDATE'
      AND OLD.tenant_id IS NULL
      AND NEW.tenant_id IS NOT NULL
      AND NEW.agent_id IS NOT NULL
      AND NEW.placement_bonus_paid_at IS NULL)
  THEN
    BEGIN
      v_result := public.credit_agent_event_bonus(
        NEW.agent_id,
        'tenant_placement',
        NEW.tenant_id,
        'house_listing:' || NEW.id::text
      );

      IF v_result->>'status' IN ('credited', 'already_credited') THEN
        NEW.placement_bonus_paid_at := now();
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Never block tenant assignment because of bonus accounting
      RAISE WARNING 'pay_tenant_placement_bonus failed for listing %: %', NEW.id, SQLERRM;
    END;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pay_tenant_placement_bonus ON public.house_listings;
CREATE TRIGGER trg_pay_tenant_placement_bonus
  BEFORE UPDATE ON public.house_listings
  FOR EACH ROW
  EXECUTE FUNCTION public.pay_tenant_placement_bonus();