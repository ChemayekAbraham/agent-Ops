-- ============================================================
-- STAGED AGENT RENT REWARDS (1,000 -> 4,000 -> 5,000)
-- Stage 1: rent request posted with a listed house  -> UGX 1,000 (this migration: trigger)
-- Stage 2: landlord of that listed-house request verified -> UGX 4,000 (this migration: trigger)
-- Stage 3: rent funded to the landlord float of that agent -> UGX 5,000 (already handled in
--          fund-agent-landlord-float / disburse-rent-to-landlord edge functions)
-- All are automatic platform marketing expenses, posted via credit_agent_event_bonus
-- (double-entry: platform marketing_expense cash_out <-> agent withdrawable cash_in).
-- ============================================================

-- 1) Add the two new staged event types to the canonical (text source_id) overload
CREATE OR REPLACE FUNCTION public.credit_agent_event_bonus(p_agent_id uuid, p_event_type text, p_tenant_id uuid, p_source_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_amount NUMERIC;
  v_description TEXT;
  v_idempotency_key TEXT;
  v_group_id UUID;
BEGIN
  v_amount := CASE p_event_type
    WHEN 'rent_posted_listed' THEN 1000
    WHEN 'rent_landlord_verified' THEN 4000
    WHEN 'rent_request_posted' THEN 5000
    WHEN 'house_listed' THEN 5000
    WHEN 'tenant_replacement' THEN 20000
    WHEN 'tenant_placement' THEN 5000
    WHEN 'subagent_registration' THEN 10000
    WHEN 'service_centre_setup' THEN 25000
    WHEN 'contact_location_capture' THEN 100
    ELSE NULL
  END;

  IF v_amount IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'Unknown event_type: ' || p_event_type);
  END IF;

  v_description := CASE p_event_type
    WHEN 'rent_posted_listed' THEN 'Reward: Rent request posted with a listed house'
    WHEN 'rent_landlord_verified' THEN 'Reward: Landlord verified'
    WHEN 'rent_request_posted' THEN 'Bonus: Rent request posted'
    WHEN 'house_listed' THEN 'Bonus: Empty house listed'
    WHEN 'tenant_replacement' THEN 'Bonus: Tenant replacement'
    WHEN 'tenant_placement' THEN 'Bonus: Tenant placed in empty house'
    WHEN 'subagent_registration' THEN 'Bonus: Sub-agent registration'
    WHEN 'service_centre_setup' THEN 'Bonus: Service Centre setup'
    WHEN 'contact_location_capture' THEN 'Bonus: Contact location captured'
  END;

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

  INSERT INTO commission_accrual_ledger (agent_id, event_type, amount, source_id, tenant_id, description, metadata)
  VALUES (
    p_agent_id, p_event_type, v_amount, p_source_id, p_tenant_id, v_description,
    jsonb_build_object('ledger_group_id', v_group_id)
  )
  ON CONFLICT DO NOTHING;

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

-- 2) Stage 1 trigger: pay UGX 1,000 the moment a rent request is linked to a listed house
CREATE OR REPLACE FUNCTION public.pay_listed_rent_posted_bonus()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.house_listing_id IS NOT NULL
     AND NEW.agent_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.house_listing_id IS NULL) THEN
    PERFORM public.credit_agent_event_bonus(
      NEW.agent_id,
      'rent_posted_listed',
      NEW.tenant_id,
      'rent_request:' || NEW.id::text
    );
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_pay_listed_rent_posted_bonus ON public.rent_requests;
CREATE TRIGGER trg_pay_listed_rent_posted_bonus
AFTER INSERT OR UPDATE OF house_listing_id ON public.rent_requests
FOR EACH ROW EXECUTE FUNCTION public.pay_listed_rent_posted_bonus();

-- 3) Stage 2 trigger: pay UGX 4,000 to the posting agent when the landlord becomes verified
CREATE OR REPLACE FUNCTION public.pay_listed_landlord_verified_bonus()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
BEGIN
  IF NEW.verified = true AND (OLD.verified IS DISTINCT FROM true) THEN
    FOR r IN
      SELECT id, agent_id, tenant_id
      FROM public.rent_requests
      WHERE landlord_id = NEW.id
        AND house_listing_id IS NOT NULL
        AND agent_id IS NOT NULL
    LOOP
      PERFORM public.credit_agent_event_bonus(
        r.agent_id,
        'rent_landlord_verified',
        r.tenant_id,
        'rent_request:' || r.id::text
      );
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_pay_listed_landlord_verified_bonus ON public.landlords;
CREATE TRIGGER trg_pay_listed_landlord_verified_bonus
AFTER UPDATE OF verified ON public.landlords
FOR EACH ROW EXECUTE FUNCTION public.pay_listed_landlord_verified_bonus();