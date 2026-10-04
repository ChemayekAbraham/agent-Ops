-- Restore the anti-bot guard on agent-assisted (server-side) registrations.
CREATE OR REPLACE FUNCTION public.record_agent_assisted_signup(
  p_actor_user_id uuid,
  p_device_fp text DEFAULT NULL,
  p_screen text DEFAULT NULL,
  p_user_agent text DEFAULT NULL,
  p_ip text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_target_role text DEFAULT 'tenant'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_actor uuid := coalesce(p_actor_user_id, auth.uid());
  v_actor_role text;
  v_ip inet;
  v_fp text;
  v_fp_valid boolean := false;
  v_screen text := nullif(btrim(coalesce(p_screen, '')), '');
  v_hour_count int := 0;
  v_day_count int := 0;
  v_status text := 'allowed';
  v_reason text := NULL;
  v_id uuid;
  c_hour_cap constant int := 5;
  c_day_cap  constant int := 15;
BEGIN
  IF v_caller IS NOT NULL AND v_actor IS DISTINCT FROM v_caller THEN
    RAISE EXCEPTION 'actor mismatch';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'actor required';
  END IF;

  BEGIN v_ip := nullif(btrim(coalesce(p_ip,'')),'')::inet; EXCEPTION WHEN others THEN v_ip := NULL; END;

  IF p_device_fp IS NOT NULL AND length(p_device_fp) > 0 THEN
    v_fp_valid := p_device_fp ~ '^[a-f0-9]{64}$' OR p_device_fp ~ '^fb_[a-f0-9]{1,64}$';
  END IF;
  v_fp := CASE WHEN v_fp_valid THEN p_device_fp ELSE NULL END;

  SELECT string_agg(role::text, ',') INTO v_actor_role
    FROM public.user_roles WHERE user_id = v_actor;

  IF v_fp IS NOT NULL THEN
    SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour'),
           count(*) FILTER (WHERE created_at > now() - interval '24 hours')
      INTO v_hour_count, v_day_count
      FROM public.signup_attempts
     WHERE device_fp = v_fp
       AND status = 'allowed'
       AND utm_medium = 'agent_assisted'
       AND created_at > now() - interval '24 hours';
  ELSE
    SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour'),
           count(*) FILTER (WHERE created_at > now() - interval '24 hours')
      INTO v_hour_count, v_day_count
      FROM public.signup_attempts
     WHERE actor_user_id = v_actor
       AND status = 'allowed'
       AND utm_medium = 'agent_assisted'
       AND created_at > now() - interval '24 hours';
  END IF;

  IF v_hour_count >= c_hour_cap THEN
    v_status := 'blocked_burst_hour';
    v_reason := format('Registration burst limit reached: %s accounts already created from this device in the last hour. Try again later or contact Operations.', v_hour_count);
  ELSIF v_day_count >= c_day_cap THEN
    v_status := 'blocked_burst_day';
    v_reason := format('Daily registration limit reached: %s accounts already created from this device in the last 24 hours. Contact Operations to raise your limit.', v_day_count);
  END IF;

  INSERT INTO public.signup_attempts(
    ip, device_fp, path, utm_source, utm_medium, utm_campaign,
    referrer, user_agent, email, phone, actor_user_id, actor_role, status, reason
  ) VALUES (
    v_ip,
    v_fp,
    coalesce(v_screen, '/agent-registration'),
    'agent_' || coalesce(nullif(btrim(coalesce(p_target_role,'')),''), 'tenant') || '_registration',
    'agent_assisted',
    NULL,
    NULL,
    nullif(btrim(coalesce(p_user_agent,'')),''),
    lower(nullif(btrim(coalesce(p_email,'')),'')),
    nullif(btrim(coalesce(p_phone,'')),''),
    v_actor, v_actor_role, v_status,
    coalesce(v_reason, CASE WHEN v_fp IS NULL THEN 'No device fingerprint supplied by client' ELSE NULL END)
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'allowed', v_status = 'allowed',
    'status', v_status,
    'reason', v_reason,
    'attempt_id', v_id,
    'hour_count', v_hour_count,
    'day_count', v_day_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_agent_assisted_signup(uuid, text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_agent_assisted_signup(uuid, text, text, text, text, text, text, text) TO authenticated, service_role;

CREATE INDEX IF NOT EXISTS idx_signup_attempts_actor_time
  ON public.signup_attempts (actor_user_id, created_at DESC)
  WHERE status = 'allowed';