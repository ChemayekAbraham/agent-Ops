CREATE OR REPLACE FUNCTION public.renew_rent_request(p_prev_request_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent uuid := auth.uid();
  v_prev  public.rent_requests%ROWTYPE;
  v_new_id uuid;
BEGIN
  IF v_agent IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  SELECT * INTO v_prev
  FROM public.rent_requests
  WHERE id = p_prev_request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PREVIOUS_REQUEST_NOT_FOUND';
  END IF;

  IF v_prev.agent_id IS DISTINCT FROM v_agent THEN
    RAISE EXCEPTION 'NOT_YOUR_REQUEST';
  END IF;

  IF v_prev.landlord_id IS NULL THEN
    RAISE EXCEPTION 'LANDLORD_MISSING';
  END IF;

  PERFORM set_config('app.bypass_daily_eligibility', 'true', true);

  INSERT INTO public.rent_requests (
    tenant_id, agent_id, landlord_id, lc1_id,
    rent_amount, duration_days,
    access_fee, request_fee, total_repayment, daily_repayment,
    status, house_category, tenant_no_smartphone,
    request_latitude, request_longitude,
    agent_guarantor_consent, agent_guarantor_consent_at, agent_guarantor_consent_version
  ) VALUES (
    v_prev.tenant_id, v_agent, v_prev.landlord_id, v_prev.lc1_id,
    v_prev.rent_amount, v_prev.duration_days,
    0, 0, 0, 0,
    'pending', v_prev.house_category, COALESCE(v_prev.tenant_no_smartphone, false),
    v_prev.request_latitude, v_prev.request_longitude,
    true, now(), 'v1'
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.renew_rent_request(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.renew_rent_request(uuid) TO authenticated, service_role;