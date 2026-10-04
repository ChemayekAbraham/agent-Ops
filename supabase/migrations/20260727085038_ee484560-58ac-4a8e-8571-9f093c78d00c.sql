-- 1) Retire orphaned "allowed" attempts (older than 2 minutes, never linked to a user)
-- so they stop blocking legitimate retries by the same person.
UPDATE public.signup_attempts
   SET status = 'abandoned',
       reason = coalesce(reason,'') || ' [auto-retired: no user linked]'
 WHERE status = 'allowed'
   AND user_id IS NULL
   AND created_at < now() - interval '2 minutes'
   AND created_at > now() - interval '48 hours';

-- 2) Update the guard to only count PRIOR SUCCESSFUL signups
CREATE OR REPLACE FUNCTION public.record_signup_attempt(
  p_ip text DEFAULT NULL,
  p_device_fp text DEFAULT NULL,
  p_path text DEFAULT NULL,
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
AS $function$
DECLARE
  v_ip inet;
  v_status text := 'allowed';
  v_reason text;
  v_id uuid;
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_is_staff boolean := false;
  v_is_exempt_path boolean := coalesce(p_path,'') ILIKE '/funder-onboarding%';
  v_recent_dev_count int := 0;
  v_recent_ua_count int := 0;
  v_fp_valid boolean := false;
  v_ua_norm text;
  v_ip_blocked boolean := false;
  v_ip_block_reason text;
BEGIN
  BEGIN v_ip := nullif(p_ip,'')::inet; EXCEPTION WHEN others THEN v_ip := NULL; END;

  IF v_actor IS NOT NULL THEN
    SELECT string_agg(role::text, ',') INTO v_actor_role FROM public.user_roles WHERE user_id = v_actor;
    v_is_staff := EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = v_actor
        AND role::text IN ('super_admin','manager','ceo','coo','cfo','cto','cmo','hr','operations','agent_ops','tenant_ops','landlord_ops','financial_ops','partner_ops','crm')
    );
  END IF;

  IF v_ip IS NOT NULL AND NOT v_is_staff AND NOT v_is_exempt_path THEN
    SELECT true, reason INTO v_ip_blocked, v_ip_block_reason
      FROM public.blocked_signup_ips WHERE ip = v_ip LIMIT 1;
    IF v_ip_blocked THEN
      v_status := 'blocked_ip';
      v_reason := coalesce('Signups from this IP are blocked. Contact support. ('||v_ip_block_reason||')',
                           'Signups from this IP are blocked. Contact support.');
    END IF;
  END IF;

  IF p_device_fp IS NOT NULL AND length(p_device_fp) > 0 THEN
    v_fp_valid :=
      p_device_fp ~ '^[a-f0-9]{64}$'
      OR p_device_fp ~ '^fb_[a-f0-9]{1,64}$';
  END IF;

  v_ua_norm := nullif(btrim(lower(coalesce(p_user_agent, ''))), '');

  IF v_status = 'allowed' AND NOT v_is_staff AND NOT v_is_exempt_path
     AND p_device_fp IS NOT NULL AND length(p_device_fp) > 0
     AND NOT v_fp_valid THEN
    v_status := 'blocked_bad_fingerprint';
    v_reason := 'Signup blocked: device fingerprint failed integrity check. Please reload the page in a normal browser tab and try again.';
  END IF;

  -- Only PRIOR SUCCESSFUL signups (user_id populated) count against the 24h limit.
  IF v_status = 'allowed' AND NOT v_is_staff AND NOT v_is_exempt_path THEN
    IF v_fp_valid THEN
      SELECT count(*) INTO v_recent_dev_count
        FROM public.signup_attempts
       WHERE device_fp = p_device_fp
         AND status = 'allowed'
         AND user_id IS NOT NULL
         AND created_at > now() - interval '24 hours'
         AND coalesce(path, '') NOT ILIKE '/funder-onboarding%';
      IF v_recent_dev_count >= 1 THEN
        v_status := 'blocked_device';
        v_reason := 'Another account was already created on this device in the last 24 hours.';
      END IF;
    END IF;

    IF v_status = 'allowed' AND v_ua_norm IS NOT NULL THEN
      SELECT count(*) INTO v_recent_ua_count
        FROM public.signup_attempts
       WHERE lower(btrim(coalesce(user_agent, ''))) = v_ua_norm
         AND status = 'allowed'
         AND user_id IS NOT NULL
         AND created_at > now() - interval '24 hours'
         AND coalesce(path, '') NOT ILIKE '/funder-onboarding%';
      IF v_recent_ua_count >= 1 THEN
        v_status := 'blocked_device';
        v_reason := 'Another account was already created on this browser/device in the last 24 hours.';
      END IF;
    END IF;
  END IF;

  INSERT INTO public.signup_attempts(
    ip, device_fp, path, utm_source, utm_medium, utm_campaign,
    referrer, user_agent, email, phone, actor_user_id, actor_role, status, reason
  ) VALUES (
    v_ip,
    CASE WHEN v_fp_valid THEN p_device_fp ELSE NULL END,
    p_path, p_utm_source, p_utm_medium, p_utm_campaign,
    p_referrer, p_user_agent,
    lower(nullif(btrim(coalesce(p_email,'')),'')),
    nullif(btrim(coalesce(p_phone,'')),''),
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
$function$;