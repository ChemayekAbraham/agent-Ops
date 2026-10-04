CREATE OR REPLACE FUNCTION public.renew_rent_request(
  p_prev_request_id uuid,
  p_latitude numeric DEFAULT NULL,
  p_longitude numeric DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_agent uuid := auth.uid();
  v_prev  public.rent_requests%ROWTYPE;
  v_new_id uuid;
  v_photo text;
  v_lat numeric;
  v_lng numeric;
  v_allowed boolean := false;
BEGIN
  IF v_agent IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  SELECT * INTO v_prev FROM public.rent_requests WHERE id = p_prev_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PREVIOUS_REQUEST_NOT_FOUND'; END IF;

  -- Who may renew: the agent who currently manages the tenant (assigned agent wins
  -- after a transfer), the agent who filed it, the manager of any of the tenant's
  -- plans, either side of a verified parent/sub-agent link, or ops/admin staff.
  v_allowed := (COALESCE(v_prev.assigned_agent_id, v_prev.agent_id) = v_agent)
            OR (v_prev.agent_id = v_agent);

  IF NOT v_allowed THEN
    SELECT true INTO v_allowed
    FROM public.rent_requests r
    WHERE r.tenant_id = v_prev.tenant_id
      AND (r.agent_id = v_agent OR r.assigned_agent_id = v_agent)
    LIMIT 1;
  END IF;

  IF NOT v_allowed THEN
    SELECT true INTO v_allowed
    FROM public.agent_subagents s
    WHERE s.status = 'verified'
      AND (
        (s.parent_agent_id = v_agent AND s.sub_agent_id IN (v_prev.agent_id, v_prev.assigned_agent_id))
        OR (s.sub_agent_id = v_agent AND s.parent_agent_id IN (v_prev.agent_id, v_prev.assigned_agent_id))
      )
    LIMIT 1;
  END IF;

  IF NOT v_allowed THEN
    v_allowed := public.has_role(v_agent, 'agent_ops')
      OR public.has_role(v_agent, 'tenant_ops')
      OR public.has_role(v_agent, 'operations')
      OR public.has_role(v_agent, 'manager')
      OR public.has_role(v_agent, 'super_admin');
  END IF;

  IF NOT COALESCE(v_allowed, false) THEN
    RAISE EXCEPTION 'NOT_YOUR_REQUEST: this tenant is handled by another agent — ask Agent Ops to transfer the tenant to you before renewing';
  END IF;

  IF v_prev.landlord_id IS NULL THEN RAISE EXCEPTION 'LANDLORD_MISSING'; END IF;

  IF p_latitude IS NOT NULL AND p_longitude IS NOT NULL THEN
    IF p_latitude < -1.6 OR p_latitude > 4.3 OR p_longitude < 29.4 OR p_longitude > 35.1 THEN
      RAISE EXCEPTION 'RENT_REQUEST_GPS_OUT_OF_RANGE: the captured GPS (%, %) is not inside Uganda — recapture it at the house',
        p_latitude, p_longitude USING ERRCODE = '23514';
    END IF;
    v_lat := p_latitude;
    v_lng := p_longitude;
  END IF;

  IF v_lat IS NULL OR v_lng IS NULL THEN
    v_lat := v_prev.request_latitude;
    v_lng := v_prev.request_longitude;
  END IF;

  IF v_lat IS NULL OR v_lng IS NULL THEN
    SELECT r.request_latitude, r.request_longitude
      INTO v_lat, v_lng
    FROM public.rent_requests r
    WHERE r.tenant_id = v_prev.tenant_id
      AND r.request_latitude IS NOT NULL
      AND r.request_longitude IS NOT NULL
    ORDER BY r.created_at DESC
    LIMIT 1;
  END IF;

  IF v_lat IS NULL OR v_lng IS NULL THEN
    SELECT h.latitude, h.longitude
      INTO v_lat, v_lng
    FROM public.house_listings h
    WHERE (h.tenant_id = v_prev.tenant_id OR h.suspended_tenant_id = v_prev.tenant_id)
      AND h.latitude IS NOT NULL
      AND h.longitude IS NOT NULL
    ORDER BY h.created_at DESC
    LIMIT 1;
  END IF;

  IF v_lat IS NULL OR v_lng IS NULL THEN
    SELECT h.latitude, h.longitude
      INTO v_lat, v_lng
    FROM public.house_listings h
    WHERE h.landlord_id = v_prev.landlord_id
      AND h.latitude IS NOT NULL
      AND h.longitude IS NOT NULL
    ORDER BY h.created_at DESC
    LIMIT 1;
  END IF;

  IF v_lat IS NULL OR v_lng IS NULL THEN
    SELECT l.latitude, l.longitude
      INTO v_lat, v_lng
    FROM public.landlords l
    WHERE l.id = v_prev.landlord_id;
  END IF;

  IF v_lat IS NULL OR v_lng IS NULL THEN
    RAISE EXCEPTION 'GPS_REQUIRED: no property GPS on record for this tenant — capture the GPS at the house to renew';
  END IF;

  SELECT tenant_photo_url INTO v_photo
  FROM public.rent_requests
  WHERE tenant_id = v_prev.tenant_id
    AND tenant_photo_url IS NOT NULL
    AND btrim(tenant_photo_url) <> ''
  ORDER BY created_at DESC
  LIMIT 1;

  PERFORM set_config('app.bypass_daily_eligibility', 'true', true);

  INSERT INTO public.rent_requests (
    tenant_id, agent_id, landlord_id, lc1_id,
    rent_amount, duration_days,
    access_fee, request_fee, total_repayment, daily_repayment,
    status, house_category, tenant_no_smartphone,
    request_latitude, request_longitude,
    tenant_photo_url, registration_type,
    agent_guarantor_consent, agent_guarantor_consent_at, agent_guarantor_consent_version
  ) VALUES (
    v_prev.tenant_id, v_agent, v_prev.landlord_id, v_prev.lc1_id,
    v_prev.rent_amount, v_prev.duration_days,
    0, 0, 0, 0,
    'pending', v_prev.house_category, COALESCE(v_prev.tenant_no_smartphone, false),
    v_lat, v_lng,
    v_photo, 'renewal',
    true, now(), 'v1'
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$fn$;