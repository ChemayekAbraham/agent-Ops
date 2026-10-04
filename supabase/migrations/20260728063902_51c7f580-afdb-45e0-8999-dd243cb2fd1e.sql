
CREATE OR REPLACE FUNCTION public.credit_agent_event_bonus(
  p_agent_id uuid,
  p_event_type text,
  p_tenant_id uuid DEFAULT NULL::uuid,
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
  v_txn_group UUID := gen_random_uuid();
  v_now TIMESTAMPTZ := now();
BEGIN
  v_amount := CASE p_event_type
    WHEN 'rent_request_posted'        THEN 5000
    WHEN 'house_listed'               THEN 2000
    WHEN 'tenant_replacement'         THEN 20000
    WHEN 'subagent_registration'      THEN 10000
    WHEN 'service_centre_setup'       THEN 25000
    WHEN 'three_verified_houses'      THEN 10000
    WHEN 'tenant_placement'           THEN 5000
    WHEN 'rent_funded_landlord_float' THEN 10000
    ELSE NULL
  END;

  IF v_amount IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'Unknown event_type: ' || p_event_type);
  END IF;

  v_description := CASE p_event_type
    WHEN 'rent_request_posted'        THEN 'Bonus: Rent request posted'
    WHEN 'house_listed'               THEN 'Bonus: Empty house listed'
    WHEN 'tenant_replacement'         THEN 'Bonus: Tenant replacement'
    WHEN 'subagent_registration'      THEN 'Bonus: Sub-agent registration'
    WHEN 'service_centre_setup'       THEN 'Bonus: Service Centre setup'
    WHEN 'three_verified_houses'      THEN 'Bonus: Sub-agent listed 3 verified houses'
    WHEN 'tenant_placement'           THEN 'Bonus: Tenant placement'
    WHEN 'rent_funded_landlord_float' THEN 'Bonus: Landlord float disbursed for registered tenant'
  END;

  IF p_source_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM commission_accrual_ledger
    WHERE source_id = p_source_id AND agent_id = p_agent_id AND event_type = p_event_type
  ) THEN
    RETURN jsonb_build_object('status', 'already_credited');
  END IF;

  PERFORM set_config('ledger.authorized', 'true', true);

  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
  VALUES (p_agent_id, v_amount, 'cash_out', 'marketing_expense', 'commission_engine', COALESCE(p_source_id::UUID, gen_random_uuid()),
    'Marketing expense: ' || v_description, 'platform', v_txn_group);

  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id, recipient_type, wallet_bucket)
  VALUES (p_agent_id, v_amount, 'cash_in', 'agent_commission', 'commission_engine', COALESCE(p_source_id::UUID, gen_random_uuid()),
    v_description, 'wallet', v_txn_group, 'user', 'withdrawable');

  INSERT INTO commission_accrual_ledger (agent_id, tenant_id, amount, percentage, event_type, commission_role, source_type, source_id, status, description, approved_at, paid_at)
  VALUES (p_agent_id, p_tenant_id, v_amount, NULL, p_event_type, 'event_bonus', p_event_type, p_source_id, 'paid', v_description, v_now, v_now);

  RETURN jsonb_build_object('status', 'ok', 'amount', v_amount, 'event_type', p_event_type);
END;
$function$;

DROP TRIGGER IF EXISTS trg_credit_verification_bonus ON public.rent_requests;

CREATE OR REPLACE FUNCTION public.credit_agent_rent_funded_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_agent_id uuid;
BEGIN
  IF NEW.funded_at IS NULL THEN RETURN NEW; END IF;
  IF OLD.funded_at IS NOT NULL THEN RETURN NEW; END IF;

  v_agent_id := NEW.agent_id;
  IF v_agent_id IS NULL THEN RETURN NEW; END IF;

  PERFORM public.credit_agent_event_bonus(
    v_agent_id, 'rent_funded_landlord_float', NEW.tenant_id, NEW.id::text
  );
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_credit_agent_rent_funded_bonus ON public.rent_requests;
CREATE TRIGGER trg_credit_agent_rent_funded_bonus
AFTER UPDATE OF funded_at ON public.rent_requests
FOR EACH ROW
EXECUTE FUNCTION public.credit_agent_rent_funded_bonus();

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT id, agent_id, tenant_id
    FROM public.rent_requests
    WHERE funded_at IS NOT NULL AND agent_id IS NOT NULL
    ORDER BY funded_at ASC
  LOOP
    PERFORM public.credit_agent_event_bonus(
      r.agent_id, 'rent_funded_landlord_float', r.tenant_id, r.id::text
    );
  END LOOP;
END $$;
