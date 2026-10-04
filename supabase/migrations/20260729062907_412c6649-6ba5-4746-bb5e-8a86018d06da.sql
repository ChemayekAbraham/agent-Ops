-- 1) Relax trigger for renewals / outstanding-balance re-posts
CREATE OR REPLACE FUNCTION public.enforce_rent_request_tenant_photo()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(NEW.registration_type, '') IN ('renewal', 'outstanding_balance') THEN
    RETURN NEW;
  END IF;

  IF NEW.tenant_photo_url IS NULL OR btrim(NEW.tenant_photo_url) = '' THEN
    -- Fall back to the tenant's most recent passport photo from an older cycle,
    -- so agents renewing/resubmitting old tenants aren't blocked.
    SELECT tenant_photo_url INTO NEW.tenant_photo_url
    FROM public.rent_requests
    WHERE tenant_id = NEW.tenant_id
      AND tenant_photo_url IS NOT NULL
      AND btrim(tenant_photo_url) <> ''
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;

  IF NEW.tenant_photo_url IS NULL OR btrim(NEW.tenant_photo_url) = '' THEN
    RAISE EXCEPTION 'Tenant passport photo is required to submit a rent request'
      USING ERRCODE = 'check_violation',
            HINT = 'Upload the tenant''s passport photo before submitting.';
  END IF;
  RETURN NEW;
END;
$function$;

-- 2) Renew RPC now carries the previous cycle's photo + stamps registration_type
CREATE OR REPLACE FUNCTION public.renew_rent_request(p_prev_request_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid := auth.uid();
  v_prev  public.rent_requests%ROWTYPE;
  v_new_id uuid;
  v_photo text;
BEGIN
  IF v_agent IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  SELECT * INTO v_prev FROM public.rent_requests WHERE id = p_prev_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PREVIOUS_REQUEST_NOT_FOUND'; END IF;
  IF v_prev.agent_id IS DISTINCT FROM v_agent THEN RAISE EXCEPTION 'NOT_YOUR_REQUEST'; END IF;
  IF v_prev.landlord_id IS NULL THEN RAISE EXCEPTION 'LANDLORD_MISSING'; END IF;

  -- Carry the freshest passport photo we have for this tenant.
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
    v_prev.request_latitude, v_prev.request_longitude,
    v_photo, 'renewal',
    true, now(), 'v1'
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$function$;