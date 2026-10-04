CREATE OR REPLACE FUNCTION public.record_signup_attempt(
  p_device_fp text,
  p_path text,
  p_utm_source text DEFAULT NULL,
  p_utm_medium text DEFAULT NULL,
  p_utm_campaign text DEFAULT NULL,
  p_referrer text DEFAULT NULL,
  p_user_agent text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_phone text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ip inet;
  v_ip_txt text;
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_is_staff boolean := false;
  v_is_exempt_path boolean := false;
  v_recent_ip_count int := 0;
  v_recent_dev_count int := 0;
  v_status text := 'allowed';
  v_reason text := NULL;
  v_id uuid;
  v_staff_roles text[] := ARRAY[
    'agent','senior_agent','sub_agent','manager','ceo','coo','cfo','cto','cmo',
    'super_admin','admin','tenant_ops','landlord_ops','agent_ops','financial_ops',
    'partner_ops','hr','employee','crm'
  ];
  v_r text;
BEGIN
  BEGIN
    v_ip_txt := split_part(
      coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ''),
      ',', 1
    );
    IF v_ip_txt IS NOT NULL AND length(btrim(v_ip_txt)) > 0 THEN
      v_ip := btrim(v_ip_txt)::inet;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
  END;

  IF v_actor IS NOT NULL THEN
    FOREACH v_r IN ARRAY v_staff_roles LOOP
      IF public.has_role(v_actor, v_r::app_role) THEN
        v_actor_role := v_r;
        v_is_staff := true;
        EXIT;
      END IF;
    END LOOP;
  END IF;

  -- Path exemption: /funder-onboarding is the ONLY path exempt from IP/device caps.
  v_is_exempt_path := coalesce(p_path, '') ILIKE '/funder-onboarding%';

  IF NOT v_is_staff AND NOT v_is_exempt_path THEN
    IF v_ip IS NOT NULL THEN
      SELECT count(*) INTO v_recent_ip_count
        FROM public.signup_attempts
       WHERE ip = v_ip
         AND status = 'allowed'
         AND created_at > now() - interval '24 hours'
         AND coalesce(path, '') NOT ILIKE '/funder-onboarding%';
      IF v_recent_ip_count >= 1 THEN
        v_status := 'blocked_ip';
        v_reason := 'Another account was already created from this network in the last 24 hours.';
      END IF;
    END IF;

    IF v_status = 'allowed' AND p_device_fp IS NOT NULL AND length(p_device_fp) > 0 THEN
      SELECT count(*) INTO v_recent_dev_count
        FROM public.signup_attempts
       WHERE device_fp = p_device_fp
         AND status = 'allowed'
         AND created_at > now() - interval '24 hours'
         AND coalesce(path, '') NOT ILIKE '/funder-onboarding%';
      IF v_recent_dev_count >= 1 THEN
        v_status := 'blocked_device';
        v_reason := 'Another account was already created on this device in the last 24 hours.';
      END IF;
    END IF;
  END IF;

  INSERT INTO public.signup_attempts(
    ip, device_fp, path, utm_source, utm_medium, utm_campaign,
    referrer, user_agent, email, phone, actor_user_id, actor_role, status, reason
  ) VALUES (
    v_ip, p_device_fp, p_path, p_utm_source, p_utm_medium, p_utm_campaign,
    p_referrer, p_user_agent, lower(nullif(btrim(coalesce(p_email,'')),'')), nullif(btrim(coalesce(p_phone,'')),''),
    v_actor, v_actor_role, v_status, v_reason
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'allowed', v_status = 'allowed',
    'status', v_status,
    'reason', v_reason,
    'attempt_id', v_id,
    'is_staff', v_is_staff OR v_is_exempt_path
  );
END;
$$;