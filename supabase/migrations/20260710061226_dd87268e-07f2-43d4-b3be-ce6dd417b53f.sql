-- Fix: sub-agent registration bonus should pay UGX 10,000 (not 3,000),
-- matching the UI EVENT_BONUSES and historical payouts. Only the amount line
-- changes; the rest of the function bodies are reproduced verbatim.

-- Primary overload: (agent, event_type, tenant, source) — used by triggers
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
  v_notif_reason TEXT;
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

  INSERT INTO commission_accrual_ledger (agent_id, source_type, event_type, amount, source_id, tenant_id, description)
  VALUES (
    p_agent_id, 'event_bonus', p_event_type, v_amount, p_source_id, p_tenant_id, v_description
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO agent_incentive_bonuses (agent_id, bonus_type, amount, description, metadata)
  VALUES (
    p_agent_id, p_event_type, v_amount, v_description,
    jsonb_build_object('source_id', p_source_id, 'tenant_id', p_tenant_id, 'ledger_group_id', v_group_id)
  );

  IF p_event_type IN ('rent_posted_listed', 'rent_landlord_verified', 'rent_request_posted') THEN
    v_notif_reason := CASE p_event_type
      WHEN 'rent_posted_listed' THEN 'Listed-house rent request posted'
      WHEN 'rent_landlord_verified' THEN 'Landlord verified'
      WHEN 'rent_request_posted' THEN 'Rent funded to landlord float'
    END;

    BEGIN
      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      VALUES (
        p_agent_id,
        'Reward earned: UGX ' || to_char(v_amount, 'FM999,999,999'),
        v_notif_reason || ' — UGX ' || to_char(v_amount, 'FM999,999,999')
          || ' has been added to your wallet. Automatic expense from Welile platform funds.',
        'success',
        jsonb_build_object(
          'event_type', p_event_type,
          'amount', v_amount,
          'reason', v_notif_reason,
          'source_id', p_source_id,
          'tenant_id', p_tenant_id,
          'ledger_group_id', v_group_id
        )
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'credit_agent_event_bonus notification failed for agent % event %: %', p_agent_id, p_event_type, SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object(
    'status', 'credited',
    'amount', v_amount,
    'event_type', p_event_type,
    'ledger_group_id', v_group_id
  );
END;
$function$;

-- Legacy overload: (agent, tenant, event_type, source)
CREATE OR REPLACE FUNCTION public.credit_agent_event_bonus(p_agent_id uuid, p_tenant_id uuid, p_event_type text, p_source_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
  VALUES (p_agent_id, v_amount, 'cash_out', 'marketing_expense', 'commission_engine', COALESCE(p_source_id::UUID, gen_random_uuid()),
    'Marketing expense: ' || v_description, 'platform', v_txn_group);

  INSERT INTO general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
  VALUES (p_agent_id, v_amount, 'cash_in', 'agent_commission', 'commission_engine', COALESCE(p_source_id::UUID, gen_random_uuid()),
    v_description, 'wallet', v_txn_group);

  INSERT INTO commission_accrual_ledger (agent_id, tenant_id, amount, percentage, event_type, commission_role, source_type, source_id, status, description)
  VALUES (p_agent_id, p_tenant_id, v_amount, NULL, p_event_type, 'event_bonus', p_event_type, p_source_id, 'earned', v_description);

  RETURN jsonb_build_object('status', 'ok', 'amount', v_amount, 'event_type', p_event_type);
END;
$function$;

-- Backfill: pay every verified sub-agent's parent who has crossed 3 valid
-- listings but was never credited (their listings predate the retroactive trigger).
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT s.sub_agent_id
    FROM public.agent_subagents s
    WHERE s.status = 'verified'
      AND s.parent_agent_id IS NOT NULL
      AND public.subagent_listing_count(s.sub_agent_id) >= 3
  LOOP
    PERFORM public.try_award_subagent_registration_bonus(r.sub_agent_id);
  END LOOP;
END $$;