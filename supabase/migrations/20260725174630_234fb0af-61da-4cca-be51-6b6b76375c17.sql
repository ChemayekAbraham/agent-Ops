
CREATE TABLE IF NOT EXISTS public.blocked_signup_ips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip inet NOT NULL UNIQUE,
  reason text NOT NULL,
  blocked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  blocked_by_role text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.blocked_signup_ips TO authenticated;
GRANT ALL ON public.blocked_signup_ips TO service_role;

ALTER TABLE public.blocked_signup_ips ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view blocked IPs"
  ON public.blocked_signup_ips FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'cto'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
  );

CREATE POLICY "Admins can manage blocked IPs"
  ON public.blocked_signup_ips FOR ALL
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'cto'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'cto'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
  );

-- Admin RPCs
CREATE OR REPLACE FUNCTION public.block_signup_ip(p_ip text, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role text := NULL;
  v_id uuid;
  v_ip inet;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT (
    public.has_role(v_actor, 'cto'::app_role)
    OR public.has_role(v_actor, 'super_admin'::app_role)
    OR public.has_role(v_actor, 'manager'::app_role)
  ) THEN
    RAISE EXCEPTION 'Only CTO / super-admin / manager can block IPs';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'Reason (min 5 chars) is required';
  END IF;
  BEGIN
    v_ip := btrim(p_ip)::inet;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invalid IP address: %', p_ip;
  END;

  SELECT CASE
    WHEN public.has_role(v_actor,'cto'::app_role) THEN 'cto'
    WHEN public.has_role(v_actor,'super_admin'::app_role) THEN 'super_admin'
    ELSE 'manager'
  END INTO v_role;

  INSERT INTO public.blocked_signup_ips(ip, reason, blocked_by, blocked_by_role)
  VALUES (v_ip, btrim(p_reason), v_actor, v_role)
  ON CONFLICT (ip) DO UPDATE
    SET reason = EXCLUDED.reason,
        blocked_by = EXCLUDED.blocked_by,
        blocked_by_role = EXCLUDED.blocked_by_role,
        created_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.unblock_signup_ip(p_ip text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_ip inet;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT (
    public.has_role(v_actor, 'cto'::app_role)
    OR public.has_role(v_actor, 'super_admin'::app_role)
    OR public.has_role(v_actor, 'manager'::app_role)
  ) THEN
    RAISE EXCEPTION 'Only CTO / super-admin / manager can unblock IPs';
  END IF;
  BEGIN
    v_ip := btrim(p_ip)::inet;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invalid IP address: %', p_ip;
  END;
  DELETE FROM public.blocked_signup_ips WHERE ip = v_ip;
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.block_signup_ip(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unblock_signup_ip(text) TO authenticated;

-- Update record_signup_attempt to short-circuit on blocked IPs
CREATE OR REPLACE FUNCTION public.record_signup_attempt(p_device_fp text, p_path text, p_utm_source text DEFAULT NULL::text, p_utm_medium text DEFAULT NULL::text, p_utm_campaign text DEFAULT NULL::text, p_referrer text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_phone text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ip inet;
  v_ip_txt text;
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_is_staff boolean := false;
  v_is_exempt_path boolean := false;
  v_recent_dev_count int := 0;
  v_recent_ua_count int := 0;
  v_ua_norm text;
  v_status text := 'allowed';
  v_reason text := NULL;
  v_id uuid;
  v_fp_valid boolean := false;
  v_ip_blocked boolean := false;
  v_ip_block_reason text := NULL;
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

  v_is_exempt_path := coalesce(p_path, '') ILIKE '/funder-onboarding%';

  -- Rule 0: hard IP block list (applies to all non-staff, all paths).
  IF v_ip IS NOT NULL AND NOT v_is_staff THEN
    SELECT true, reason INTO v_ip_blocked, v_ip_block_reason
      FROM public.blocked_signup_ips
     WHERE ip = v_ip
     LIMIT 1;
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

  IF v_status = 'allowed' AND NOT v_is_staff AND NOT v_is_exempt_path THEN
    IF v_fp_valid THEN
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

    IF v_status = 'allowed' AND v_ua_norm IS NOT NULL THEN
      SELECT count(*) INTO v_recent_ua_count
        FROM public.signup_attempts
       WHERE lower(btrim(coalesce(user_agent, ''))) = v_ua_norm
         AND status = 'allowed'
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
