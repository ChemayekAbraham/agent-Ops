CREATE OR REPLACE FUNCTION public.create_landlord_float_allocation(p_agent_id uuid, p_rent_request_id uuid, p_amount numeric, p_source text DEFAULT 'cfo_disbursement'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_existing uuid;
  v_tenant_id uuid;
  v_landlord_id uuid;
  v_landlord_name text;
  v_landlord_phone text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Allocation amount must be positive';
  END IF;

  -- Idempotency guard: only reuse a still-LIVE allocation (open / partially_paid).
  -- A previously CANCELLED allocation (e.g. CFO-approved return / resubmit) or a
  -- FULLY_PAID one must NOT block a fresh disbursement — otherwise a re-funded
  -- request silently reuses the dead row and the agent never gets payable float.
  SELECT id INTO v_existing
  FROM public.agent_landlord_float_allocations
  WHERE agent_id = p_agent_id
    AND rent_request_id = p_rent_request_id
    AND source = p_source
    AND status IN ('open', 'partially_paid')
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  SELECT rr.tenant_id, rr.landlord_id
  INTO v_tenant_id, v_landlord_id
  FROM public.rent_requests rr
  WHERE rr.id = p_rent_request_id;

  SELECT l.name, COALESCE(l.mobile_money_number, l.phone)
  INTO v_landlord_name, v_landlord_phone
  FROM public.landlords l
  WHERE l.id = v_landlord_id;

  INSERT INTO public.agent_landlord_float_allocations (
    agent_id, tenant_id, rent_request_id, landlord_id,
    landlord_name, landlord_phone,
    allocated_amount, source
  ) VALUES (
    p_agent_id, v_tenant_id, p_rent_request_id, v_landlord_id,
    COALESCE(v_landlord_name, 'Unknown Landlord'), v_landlord_phone,
    p_amount, p_source
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;