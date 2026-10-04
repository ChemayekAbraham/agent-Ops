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
    WHEN 'tenant_placement'           THEN 10000
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

  INSERT INTO commission_accrual_ledger (
    agent_id,
    event_type,
    tenant_id,
    source_id,
    amount,
    description,
    status,
    txn_group,
    created_at
  ) VALUES (
    p_agent_id,
    p_event_type,
    p_tenant_id,
    p_source_id,
    v_amount,
    v_description,
    'pending',
    v_txn_group,
    v_now
  );

  PERFORM public.apply_wallet_movement(
    p_user_id       := p_agent_id,
    p_amount        := v_amount,
    p_movement_type := 'credit',
    p_category      := 'tenant_placement_bonus',
    p_description   := v_description,
    p_source_id     := p_source_id,
    p_recipient_type:= 'user'
  );

  UPDATE commission_accrual_ledger
  SET status = 'credited', credited_at = v_now
  WHERE txn_group = v_txn_group;

  RETURN jsonb_build_object(
    'status', 'credited',
    'event_type', p_event_type,
    'amount', v_amount,
    'description', v_description
  );
END;
$function$;
