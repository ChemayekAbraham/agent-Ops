
-- =====================================================================
-- 1. signup_attempts table
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.signup_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip inet,
  device_fp text,
  path text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  referrer text,
  user_agent text,
  email text,
  phone text,
  actor_user_id uuid,
  actor_role text,
  user_id uuid,
  status text NOT NULL DEFAULT 'allowed',
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.signup_attempts TO authenticated;
GRANT ALL ON public.signup_attempts TO service_role;

ALTER TABLE public.signup_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "signup_attempts admin read"
  ON public.signup_attempts FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cmo')
    OR public.has_role(auth.uid(), 'manager')
  );

CREATE INDEX IF NOT EXISTS idx_signup_attempts_created_at
  ON public.signup_attempts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signup_attempts_ip_time
  ON public.signup_attempts (ip, created_at DESC) WHERE status = 'allowed';
CREATE INDEX IF NOT EXISTS idx_signup_attempts_device_time
  ON public.signup_attempts (device_fp, created_at DESC) WHERE status = 'allowed';
CREATE INDEX IF NOT EXISTS idx_signup_attempts_path
  ON public.signup_attempts (path, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signup_attempts_user
  ON public.signup_attempts (user_id) WHERE user_id IS NOT NULL;

-- =====================================================================
-- 2. Rate-limit + logging RPC (called from client before signUp)
-- =====================================================================
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
  -- Resolve caller IP from PostgREST forwarded headers
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

  -- Determine actor role (if any authenticated staff is calling on behalf of someone)
  IF v_actor IS NOT NULL THEN
    FOREACH v_r IN ARRAY v_staff_roles LOOP
      IF public.has_role(v_actor, v_r::app_role) THEN
        v_actor_role := v_r;
        v_is_staff := true;
        EXIT;
      END IF;
    END LOOP;
  END IF;

  -- Rate-limit only self-service signups
  IF NOT v_is_staff THEN
    IF v_ip IS NOT NULL THEN
      SELECT count(*) INTO v_recent_ip_count
        FROM public.signup_attempts
       WHERE ip = v_ip
         AND status = 'allowed'
         AND created_at > now() - interval '24 hours';
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
         AND created_at > now() - interval '24 hours';
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
    'is_staff', v_is_staff
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_signup_attempt(text,text,text,text,text,text,text,text,text) TO anon, authenticated;

-- =====================================================================
-- 3. Post-signup attribution: link an attempt to the created user
-- =====================================================================
CREATE OR REPLACE FUNCTION public.attach_signup_attempt_user(
  p_attempt_id uuid,
  p_user_id uuid
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.signup_attempts
     SET user_id = p_user_id
   WHERE id = p_attempt_id
     AND user_id IS NULL;
$$;

GRANT EXECUTE ON FUNCTION public.attach_signup_attempt_user(uuid, uuid) TO anon, authenticated;

-- =====================================================================
-- 4. Phone-only OTP hard-block trigger on profiles
-- =====================================================================
CREATE OR REPLACE FUNCTION public.enforce_signup_verification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_role text;
  v_has_email boolean;
  v_verified boolean;
  v_norm_phone text;
BEGIN
  v_actor_role := coalesce(current_setting('app.signup_actor_role', true), '');
  IF v_actor_role IN (
    'agent','senior_agent','sub_agent','manager','ceo','coo','cfo','cto','cmo',
    'super_admin','admin','tenant_ops','landlord_ops','agent_ops','financial_ops',
    'partner_ops','hr','employee','crm','service_role'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT (email IS NOT NULL AND length(btrim(email)) > 0)
    INTO v_has_email
    FROM auth.users
   WHERE id = NEW.id;

  -- Phone-only signup: require verified OTP within 15 minutes
  IF NEW.phone IS NOT NULL AND length(btrim(NEW.phone)) > 0 AND coalesce(v_has_email, false) = false THEN
    BEGIN
      v_norm_phone := public.normalize_ug_phone(NEW.phone);
    EXCEPTION WHEN OTHERS THEN
      v_norm_phone := NEW.phone;
    END;

    SELECT EXISTS(
      SELECT 1
        FROM public.phone_verifications
       WHERE (phone = v_norm_phone OR phone = NEW.phone)
         AND verified_at IS NOT NULL
         AND verified_at > now() - interval '15 minutes'
    ) INTO v_verified;

    IF NOT v_verified THEN
      RAISE EXCEPTION 'signup_otp_required: phone-only signups must complete OTP verification'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_signup_verification ON public.profiles;
CREATE TRIGGER trg_enforce_signup_verification
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_signup_verification();

-- =====================================================================
-- 5. CTO analytics RPCs
-- =====================================================================
CREATE OR REPLACE FUNCTION public.get_signup_source_breakdown(
  p_days int DEFAULT 7
)
RETURNS TABLE (
  path text,
  utm_source text,
  total_attempts bigint,
  allowed bigint,
  blocked_ip bigint,
  blocked_device bigint,
  blocked_verification bigint,
  successful_signups bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    coalesce(sa.path, '(unknown)')                        AS path,
    coalesce(sa.utm_source, '(none)')                     AS utm_source,
    count(*)::bigint                                      AS total_attempts,
    count(*) FILTER (WHERE sa.status = 'allowed')::bigint AS allowed,
    count(*) FILTER (WHERE sa.status = 'blocked_ip')::bigint AS blocked_ip,
    count(*) FILTER (WHERE sa.status = 'blocked_device')::bigint AS blocked_device,
    count(*) FILTER (WHERE sa.status = 'blocked_verification')::bigint AS blocked_verification,
    count(*) FILTER (WHERE sa.user_id IS NOT NULL)::bigint AS successful_signups
    FROM public.signup_attempts sa
   WHERE sa.created_at > now() - make_interval(days => greatest(p_days, 1))
     AND (
       public.has_role(auth.uid(), 'super_admin')
       OR public.has_role(auth.uid(), 'admin')
       OR public.has_role(auth.uid(), 'cto')
       OR public.has_role(auth.uid(), 'ceo')
       OR public.has_role(auth.uid(), 'coo')
       OR public.has_role(auth.uid(), 'cmo')
       OR public.has_role(auth.uid(), 'manager')
     )
   GROUP BY 1, 2
   ORDER BY total_attempts DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_signup_source_breakdown(int) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_signup_attempt_log(
  p_days int DEFAULT 7,
  p_limit int DEFAULT 200,
  p_status text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  ip inet,
  device_fp text,
  path text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  email text,
  phone text,
  user_id uuid,
  status text,
  reason text,
  actor_role text,
  user_agent text,
  created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, ip, device_fp, path, utm_source, utm_medium, utm_campaign,
         email, phone, user_id, status, reason, actor_role, user_agent, created_at
    FROM public.signup_attempts sa
   WHERE sa.created_at > now() - make_interval(days => greatest(p_days, 1))
     AND (p_status IS NULL OR sa.status = p_status)
     AND (
       public.has_role(auth.uid(), 'super_admin')
       OR public.has_role(auth.uid(), 'admin')
       OR public.has_role(auth.uid(), 'cto')
       OR public.has_role(auth.uid(), 'ceo')
       OR public.has_role(auth.uid(), 'coo')
       OR public.has_role(auth.uid(), 'cmo')
       OR public.has_role(auth.uid(), 'manager')
     )
   ORDER BY sa.created_at DESC
   LIMIT least(greatest(p_limit, 1), 1000);
$$;

GRANT EXECUTE ON FUNCTION public.get_signup_attempt_log(int, int, text) TO authenticated;
