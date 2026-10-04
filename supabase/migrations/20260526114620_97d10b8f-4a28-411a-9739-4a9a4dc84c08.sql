-- 1) Extend the event-bonus helper with a UGX 100 contact_location_capture event
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


-- 2) Make GPS optional in agent_capture_contact_location and pay the agent UGX 100 bonus
CREATE OR REPLACE FUNCTION public.agent_capture_contact_location(
  p_target_id uuid,
  p_target_role text,
  p_address jsonb,
  p_latitude double precision DEFAULT NULL,
  p_longitude double precision DEFAULT NULL,
  p_accuracy double precision DEFAULT NULL,
  p_landmark text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_agent_id uuid := auth.uid();
  v_visit_id uuid;
  v_bonus jsonb;
BEGIN
  IF v_agent_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT public.has_agent_contact_relationship(v_agent_id, p_target_id) THEN
    RAISE EXCEPTION 'Agent does not have a managing relationship with this contact';
  END IF;

  -- Address-only mode is allowed; GPS is optional.
  UPDATE public.profiles SET
    continent  = COALESCE(NULLIF(p_address->>'continent', ''), continent),
    country    = COALESCE(NULLIF(p_address->>'country', ''),   country),
    region     = COALESCE(NULLIF(p_address->>'region', ''),    region),
    district   = COALESCE(NULLIF(p_address->>'district', ''),  district),
    city       = COALESCE(NULLIF(p_address->>'city', ''),      city),
    town       = COALESCE(NULLIF(p_address->>'town', ''),      town),
    sub_county = COALESCE(NULLIF(p_address->>'sub_county', ''),sub_county),
    parish     = COALESCE(NULLIF(p_address->>'parish', ''),    parish),
    village    = COALESCE(NULLIF(p_address->>'village', ''),   village),
    landmark   = COALESCE(NULLIF(p_landmark, ''),              landmark),
    residence_lat = COALESCE(p_latitude, residence_lat),
    residence_lng = COALESCE(p_longitude, residence_lng),
    residence_updated_at = CASE WHEN p_latitude IS NOT NULL THEN now() ELSE residence_updated_at END,
    address_complete = true,
    address_completed_at = now(),
    updated_at = now()
  WHERE id = p_target_id;

  IF p_latitude IS NOT NULL AND p_longitude IS NOT NULL THEN
    INSERT INTO public.agent_visits (
      agent_id, tenant_id, latitude, longitude, accuracy, location_name
    ) VALUES (
      v_agent_id, p_target_id, p_latitude, p_longitude, p_accuracy,
      COALESCE(p_landmark, 'Location capture (' || p_target_role || ')')
    )
    RETURNING id INTO v_visit_id;

    BEGIN
      PERFORM public.capture_trust_signal(
        p_target_id,
        'agent_location_capture',
        'residence',
        COALESCE(p_landmark, 'Captured by agent'),
        p_latitude,
        p_longitude,
        p_accuracy,
        'Agent ' || v_agent_id::text || ' captured contact location'
      );
    EXCEPTION WHEN OTHERS THEN
      -- Don't block the save if trust scoring fails
      NULL;
    END;
  END IF;

  -- Pay the agent UGX 100 — idempotent per (agent, target)
  BEGIN
    v_bonus := public.credit_agent_event_bonus(
      v_agent_id,
      'contact_location_capture',
      p_target_id,
      'loc:' || p_target_id::text
    );
  EXCEPTION WHEN OTHERS THEN
    v_bonus := jsonb_build_object('status', 'error', 'message', SQLERRM);
  END;

  INSERT INTO public.system_events (
    event_type, user_id, related_entity_type, related_entity_id, metadata
  )
  VALUES (
    'agent.contact_location_captured',
    v_agent_id,
    p_target_role,
    p_target_id,
    jsonb_build_object(
      'target_role', p_target_role,
      'target_id', p_target_id,
      'visit_id', v_visit_id,
      'lat', p_latitude,
      'lng', p_longitude,
      'accuracy', p_accuracy,
      'bonus', v_bonus
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'visit_id', v_visit_id,
    'target_id', p_target_id,
    'bonus', v_bonus
  );
END;
$function$;