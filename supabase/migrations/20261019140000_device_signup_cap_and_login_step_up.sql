-- Fewer fake accounts per device (2026-10-19).
--
-- 1. Signup: at most 2 self-signups per device fingerprint, ever (plus the existing
--    1-per-24h rule). Agent-assisted and funder-onboarding signups are exempt, as
--    before. One helper, used by handle_new_user, both record_signup_attempt
--    overloads, and phone-signup (for a readable message: GoTrue turns trigger
--    errors into "Database error saving new user").
-- 2. Sign-in: login_devices records which accounts sign in on which device. The
--    third and later public account to sign in on a device must confirm a code
--    sent by SMS to that account's own phone (device-step-up edge function),
--    once per account per device. Staff are exempt (they have email 2FA).
--    Enforcement is switched by system_config key device_step_up_enforce;
--    with it off, devices are still recorded and flagged for review.
-- 3. Review: get_shared_login_devices lists devices used by several accounts.
--
-- handle_new_user and record_signup_attempt bodies below were taken from the LIVE
-- database (migrations drift), with only the marked device-limit lines changed.

CREATE OR REPLACE FUNCTION public.signup_device_lifetime_count(p_device_fp text)
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT count(*)::int
    FROM public.profiles p
   WHERE p.signup_device_fp = p_device_fp
     AND COALESCE(p.signup_channel, '') <> 'agent_assisted'
     AND COALESCE(p.signup_source, '') <> 'funder-onboarding'
$$;
REVOKE ALL ON FUNCTION public.signup_device_lifetime_count(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.signup_device_lifetime_count(text) TO service_role;

-- Why a self-signup from this device would be refused, or NULL. Used by phone-signup.
CREATE OR REPLACE FUNCTION public.signup_device_block_reason(p_device_fp text)
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF p_device_fp IS NULL OR NOT (p_device_fp ~ '^[a-f0-9]{64}$' OR p_device_fp ~ '^fb_[a-f0-9]{1,64}$') THEN
    RETURN NULL;
  END IF;
  IF public.signup_device_lifetime_count(p_device_fp) >= 2 THEN
    RETURN 'This device already has 2 Welile accounts. Sign in to one of them, or create the new account on a different phone.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.signup_device_fp = p_device_fp
       AND COALESCE(p.signup_channel, '') <> 'agent_assisted'
       AND COALESCE(p.signup_source, '') <> 'funder-onboarding'
       AND p.created_at > now() - interval '24 hours'
  ) THEN
    RETURN 'An account was already created on this device in the last 24 hours. Please try again tomorrow.';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.signup_device_block_reason(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.signup_device_block_reason(text) TO service_role;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_referrer_id_raw text;
  v_referrer_id uuid;
  v_referrer_valid boolean := FALSE;
  v_intended_role text;
  v_signup_source text;
  v_funder_ref text;
  v_referrer_is_agent boolean := FALSE;
  v_phone_in text;
  v_phone_taken_by uuid;
  v_full_name_in text;
  v_roles_to_assign text[];
  v_role text;
  v_campaign_token text;
  v_campaign_agent_id uuid;
  v_campaign_result jsonb;
  v_recent_hour_count int := 0;
  v_recent_day_count int := 0;
  v_device_fp text;
  v_signup_channel text;
  v_device_count int := 0;
BEGIN
  v_referrer_id_raw := NULLIF(NEW.raw_user_meta_data->>'referrer_id', '');
  IF v_referrer_id_raw IS NOT NULL THEN
    BEGIN
      v_referrer_id := v_referrer_id_raw::uuid;
    EXCEPTION WHEN OTHERS THEN
      v_referrer_id := NULL;
      RAISE WARNING 'handle_new_user: dropped malformed referrer_id "%" for new user %', v_referrer_id_raw, NEW.id;
    END;
  END IF;

  IF v_referrer_id IS NOT NULL THEN
    IF v_referrer_id = NEW.id THEN
      RAISE WARNING 'handle_new_user: dropped self-referral for user %', NEW.id;
      v_referrer_id := NULL;
    ELSE
      SELECT EXISTS (
        SELECT 1
        FROM auth.users au
        LEFT JOIN public.profiles p ON p.id = au.id
        WHERE au.id = v_referrer_id
          AND COALESCE(p.is_frozen, FALSE) = FALSE
      ) INTO v_referrer_valid;

      IF NOT v_referrer_valid THEN
        RAISE WARNING 'handle_new_user: dropped invalid/frozen referrer % for new user %', v_referrer_id, NEW.id;
        v_referrer_id := NULL;
      END IF;
    END IF;
  END IF;

  -- Signup-velocity guard, hardened 2026-09-14 per Josh's explicit request to
  -- make this "so hard" a repeat is not possible. Original cap (15/hour) was
  -- loose enough that the confirmed fraud ring's fastest cluster (Kintu Amad,
  -- 63 signups in 6.7 minutes) would have tripped it almost instantly anyway,
  -- but the cap is now brought down to match the same dual hour+day standard
  -- already trusted in production for the agent-assisted paths
  -- (record_agent_assisted_signup: 5/hour, 15/day) -- 5 signups/hour OR 10/day
  -- from the same referral link is rejected outright. This fires as a
  -- trigger on auth.users itself, so it cannot be bypassed by calling the
  -- Auth REST endpoint directly the way the client-side signupGuard.ts check
  -- can be. Legitimate high-volume agent recruitment (e.g. a field agent
  -- onboarding real sub-agents/tenants via register-tenant /
  -- submit-tenant-form) is unaffected -- those paths create the auth user
  -- via auth.admin.createUser() without referrer_id in raw_user_meta_data,
  -- so this branch never runs for them; they have their own separate caps.
  -- See docs/HANDOVER/21-referral-bonus-bot-signup-fraud-ring.md and
  -- docs/HANDOVER/22-signup-entry-points-hardening.md.
  IF v_referrer_id IS NOT NULL THEN
    SELECT
      count(*) FILTER (WHERE created_at > now() - interval '1 hour'),
      count(*) FILTER (WHERE created_at > now() - interval '24 hours')
    INTO v_recent_hour_count, v_recent_day_count
    FROM public.profiles
    WHERE referrer_id = v_referrer_id
      AND created_at > now() - interval '24 hours';

    IF v_recent_hour_count >= 5 THEN
      RAISE EXCEPTION 'signup_velocity_blocked: too many signups from this referral link in the last hour; please try again later'
        USING ERRCODE = '28000';
    ELSIF v_recent_day_count >= 10 THEN
      RAISE EXCEPTION 'signup_velocity_blocked: too many signups from this referral link today; please try again tomorrow or contact support'
        USING ERRCODE = '28000';
    END IF;
  END IF;

  -- ===== Per device: at most 2 self-signups ever, and 1 per 24 hours =====
  v_device_fp := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data->>'device_fp', '')), '');
  v_signup_channel := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data->>'signup_channel', '')), '');

  IF v_device_fp IS NOT NULL
     AND NOT (v_device_fp ~ '^[a-f0-9]{64}$' OR v_device_fp ~ '^fb_[a-f0-9]{1,64}$') THEN
    v_device_fp := NULL;
  END IF;

  -- Self-signups only: agent-assisted signups have their own per-agent caps, and
  -- funder onboarding is done by staff from shared office machines.
  IF v_device_fp IS NOT NULL AND v_signup_channel IS DISTINCT FROM 'agent_assisted'
     AND COALESCE(NEW.raw_user_meta_data->>'signup_source', '') <> 'funder-onboarding' THEN
    -- Lifetime cap: at most 2 self-signups per device.
    IF public.signup_device_lifetime_count(v_device_fp) >= 2 THEN
      RAISE EXCEPTION 'signup_device_limit: this device already has 2 accounts; please sign in to one of them or use a different phone'
        USING ERRCODE = '28000';
    END IF;

    SELECT count(*) INTO v_device_count
    FROM public.profiles p
    WHERE p.signup_device_fp = v_device_fp
      AND COALESCE(p.signup_channel, '') <> 'agent_assisted'
      AND COALESCE(p.signup_source, '') <> 'funder-onboarding'
      AND p.created_at > now() - interval '24 hours';

    IF v_device_count >= 1 THEN
      RAISE EXCEPTION 'signup_device_blocked: an account was already created on this device in the last 24 hours; please try again tomorrow or contact support'
        USING ERRCODE = '28000';
    END IF;
  END IF;

  v_intended_role := NULLIF(NEW.raw_user_meta_data->>'intended_role', '');
  IF v_intended_role IS NULL THEN
    v_intended_role := NULLIF(NEW.raw_user_meta_data->>'role', '');
  END IF;
  v_signup_source := NULLIF(NEW.raw_user_meta_data->>'signup_source', '');
  v_campaign_token := NULLIF(NEW.raw_user_meta_data->>'campaign_attribution_token', '');
  v_phone_in := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data->>'phone', '')), '');
  v_full_name_in := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data->>'full_name', '')), '');

  IF v_referrer_id IS NULL AND v_campaign_token IS NOT NULL THEN
    BEGIN
      SELECT ca.referring_agent_id INTO v_campaign_agent_id
      FROM public.campaign_attributions ca
      JOIN public.recruitment_campaign_links l ON l.id = ca.campaign_link_id
      JOIN public.recruitment_campaigns c ON c.id = ca.campaign_id
      LEFT JOIN public.profiles p ON p.id = ca.referring_agent_id
      WHERE ca.attribution_token = v_campaign_token
        AND ca.status IN ('active', 'registration_started')
        AND ca.expires_at > now()
        AND l.status = 'active'
        AND c.status = 'active'
        AND ca.referring_agent_id <> NEW.id
        AND COALESCE(p.is_frozen, FALSE) = FALSE
      LIMIT 1;

      IF v_campaign_agent_id IS NOT NULL THEN
        v_referrer_id := v_campaign_agent_id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'handle_new_user: campaign attribution lookup failed for user %: %', NEW.id, SQLERRM;
    END;
  END IF;

  IF public.is_fraud_identifier_blocked('user_id', NEW.id::text)
     OR (NEW.email IS NOT NULL AND public.is_fraud_identifier_blocked('email', NEW.email))
     OR (v_phone_in IS NOT NULL AND public.is_fraud_identifier_blocked('phone', v_phone_in))
     OR (v_phone_in IS NOT NULL AND public.is_fraud_identifier_blocked('mobile_money_number', v_phone_in))
     OR (v_full_name_in IS NOT NULL
         AND length(public.fraud_normalize_identifier('full_name', v_full_name_in)) >= 5
         AND public.is_fraud_identifier_blocked('full_name', v_full_name_in)) THEN
    RAISE EXCEPTION 'fraud_blocked_identifier: this phone/email/name is permanently restricted from Welile signup'
      USING ERRCODE = '28000';
  END IF;

  IF v_signup_source = 'funder-onboarding' THEN
    v_funder_ref := public.build_funder_reference(NEW.id, NEW.created_at);
  ELSE
    v_funder_ref := NULL;
  END IF;

  IF v_phone_in IS NOT NULL THEN
    SELECT id INTO v_phone_taken_by
    FROM public.profiles
    WHERE normalize_phone_last9(phone) = normalize_phone_last9(v_phone_in)
    LIMIT 1;

    IF v_phone_taken_by IS NOT NULL THEN
      RAISE EXCEPTION 'phone_already_registered: % is already linked to another account', v_phone_in
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  INSERT INTO public.profiles (id, email, full_name, phone, referrer_id, signup_source, funder_reference, signup_device_fp, signup_channel)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    v_phone_in,
    v_referrer_id,
    v_signup_source,
    v_funder_ref,
    v_device_fp,
    v_signup_channel
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), profiles.full_name),
    phone = COALESCE(EXCLUDED.phone, profiles.phone),
    referrer_id = COALESCE(EXCLUDED.referrer_id, profiles.referrer_id),
    signup_source = COALESCE(profiles.signup_source, EXCLUDED.signup_source),
    funder_reference = COALESCE(profiles.funder_reference, EXCLUDED.funder_reference),
    signup_device_fp = COALESCE(profiles.signup_device_fp, EXCLUDED.signup_device_fp),
    signup_channel   = COALESCE(profiles.signup_channel, EXCLUDED.signup_channel),
    updated_at = now();

  IF v_intended_role IN ('agent','tenant','landlord','supporter') THEN
    v_roles_to_assign := ARRAY[v_intended_role];
  ELSE
    v_roles_to_assign := ARRAY['agent','tenant','landlord','supporter'];
  END IF;

  FOREACH v_role IN ARRAY v_roles_to_assign LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role, enabled)
      VALUES (NEW.id, v_role::app_role, TRUE)
      ON CONFLICT (user_id, role) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'handle_new_user: failed to assign role % to %: %', v_role, NEW.id, SQLERRM;
    END;
  END LOOP;

  IF v_intended_role = 'agent' AND v_referrer_id IS NOT NULL AND v_referrer_id <> NEW.id THEN
    BEGIN
      SELECT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = v_referrer_id AND role = 'agent'
      ) INTO v_referrer_is_agent;

      IF v_referrer_is_agent THEN
        INSERT INTO public.agent_subagents (parent_agent_id, sub_agent_id, source, status, verified_at)
        VALUES (v_referrer_id, NEW.id, 'campaign_signup', 'verified', now())
        ON CONFLICT (sub_agent_id) DO NOTHING;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'handle_new_user AGENT LINK failed for %: % / SQLSTATE=%', NEW.id, SQLERRM, SQLSTATE;
    END;
  END IF;

  IF v_campaign_token IS NOT NULL THEN
    BEGIN
      v_campaign_result := public.complete_campaign_attribution_for_user(v_campaign_token, NEW.id);
      RAISE LOG 'handle_new_user: completed campaign attribution for %: %', NEW.id, v_campaign_result;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'handle_new_user campaign completion failed for %: % / SQLSTATE=%', NEW.id, SQLERRM, SQLSTATE;
    END;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_signup_attempt(p_device_fp text, p_path text, p_utm_source text DEFAULT NULL::text, p_utm_medium text DEFAULT NULL::text, p_utm_campaign text DEFAULT NULL::text, p_referrer text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_phone text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ip inet;
  v_ip_txt text;
  v_headers jsonb;
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
    v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
    v_ip_txt := nullif(v_headers ->> 'cf-connecting-ip', '');
    IF v_ip_txt IS NULL THEN
      v_ip_txt := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
    END IF;
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

    -- Lifetime cap: at most 2 self-signups per device (same rule as handle_new_user).
    IF v_fp_valid AND public.signup_device_lifetime_count(p_device_fp) >= 2 THEN
      v_status := 'blocked_device';
      v_reason := 'This device already has 2 Welile accounts. Sign in to one of them, or create the new account on a different phone.';
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

CREATE OR REPLACE FUNCTION public.record_signup_attempt(p_ip text DEFAULT NULL::text, p_device_fp text DEFAULT NULL::text, p_path text DEFAULT NULL::text, p_utm_source text DEFAULT NULL::text, p_utm_medium text DEFAULT NULL::text, p_utm_campaign text DEFAULT NULL::text, p_referrer text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_phone text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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

    -- Lifetime cap: at most 2 self-signups per device (same rule as handle_new_user).
    IF v_fp_valid AND public.signup_device_lifetime_count(p_device_fp) >= 2 THEN
      v_status := 'blocked_device';
      v_reason := 'This device already has 2 Welile accounts. Sign in to one of them, or create the new account on a different phone.';
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

-- ===== Sign-in devices =====

CREATE TABLE IF NOT EXISTS public.login_devices (
  device_fp text NOT NULL CHECK (device_fp ~ '^[a-f0-9]{64}$' OR device_fp ~ '^fb_[a-f0-9]{1,64}$'),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  hw_fp text,
  user_agent text,
  -- clock_timestamp, not now(): sign-in order decides who is challenged.
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  login_count integer NOT NULL DEFAULT 1,
  -- Set the first time this account needed the step-up on this device.
  step_up_required_at timestamptz,
  -- Set when the account's owner confirmed the SMS code on this device.
  step_up_verified_at timestamptz,
  PRIMARY KEY (device_fp, user_id)
);
CREATE INDEX IF NOT EXISTS idx_login_devices_user ON public.login_devices (user_id);
CREATE INDEX IF NOT EXISTS idx_login_devices_hw ON public.login_devices (hw_fp) WHERE hw_fp IS NOT NULL;
ALTER TABLE public.login_devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.login_devices FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.device_step_up_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_fp text NOT NULL,
  code_hash text NOT NULL,
  phone text,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_device_step_up_challenges_user ON public.device_step_up_challenges (user_id, created_at DESC);
ALTER TABLE public.device_step_up_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.device_step_up_challenges FROM anon, authenticated;

-- True when the user holds any role outside the public set (agents, tenants, landlords, funders).
CREATE OR REPLACE FUNCTION public.is_staff_account(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles r
     WHERE r.user_id = p_user_id
       AND r.role::text NOT IN ('agent', 'tenant', 'landlord', 'supporter', 'senior_agent', 'sub_agent')
  )
$$;
REVOKE ALL ON FUNCTION public.is_staff_account(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_staff_account(uuid) TO service_role;

-- Records a sign-in on a device and says whether this account must confirm an SMS code
-- on it: it is the 3rd or later public account to sign in on the device, and has not
-- confirmed one here before. The device's first two accounts are never challenged.
CREATE OR REPLACE FUNCTION public.register_login_device(
  p_user_id uuid, p_device_fp text, p_hw_fp text DEFAULT NULL, p_user_agent text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row public.login_devices;
  v_staff boolean;
  v_earlier integer := 0;
  v_required boolean;
BEGIN
  IF p_user_id IS NULL OR p_device_fp IS NULL
     OR NOT (p_device_fp ~ '^[a-f0-9]{64}$' OR p_device_fp ~ '^fb_[a-f0-9]{1,64}$') THEN
    RETURN jsonb_build_object('step_up_required', false, 'reason', 'no_fingerprint');
  END IF;
  IF p_hw_fp IS NOT NULL AND NOT (p_hw_fp ~ '^[a-f0-9]{64}$' OR p_hw_fp ~ '^fb_[a-f0-9]{1,64}$') THEN
    p_hw_fp := NULL;
  END IF;

  INSERT INTO public.login_devices (device_fp, user_id, hw_fp, user_agent)
  VALUES (p_device_fp, p_user_id, p_hw_fp, left(p_user_agent, 300))
  ON CONFLICT (device_fp, user_id) DO UPDATE
     SET last_seen_at = now(),
         login_count = public.login_devices.login_count + 1,
         hw_fp = COALESCE(EXCLUDED.hw_fp, public.login_devices.hw_fp),
         user_agent = COALESCE(EXCLUDED.user_agent, public.login_devices.user_agent)
  RETURNING * INTO v_row;

  v_staff := public.is_staff_account(p_user_id);

  SELECT count(*) INTO v_earlier
    FROM public.login_devices o
   WHERE o.device_fp = p_device_fp
     AND o.user_id <> p_user_id
     AND o.first_seen_at < v_row.first_seen_at
     AND NOT public.is_staff_account(o.user_id);

  v_required := NOT v_staff AND v_earlier >= 2 AND v_row.step_up_verified_at IS NULL;

  IF v_required AND v_row.step_up_required_at IS NULL THEN
    UPDATE public.login_devices SET step_up_required_at = now()
     WHERE device_fp = p_device_fp AND user_id = p_user_id;
  END IF;

  RETURN jsonb_build_object(
    'step_up_required', v_required,
    'earlier_accounts', v_earlier,
    'verified', v_row.step_up_verified_at IS NOT NULL,
    'is_staff', v_staff
  );
END
$$;
REVOKE ALL ON FUNCTION public.register_login_device(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_login_device(uuid, text, text, text) TO service_role;

-- Review list: devices that several public accounts sign in on. Staff reports only.
CREATE OR REPLACE FUNCTION public.get_shared_login_devices(p_min_accounts integer DEFAULT 3, p_limit integer DEFAULT 200)
RETURNS TABLE(
  device_fp text,
  accounts bigint,
  accounts_needing_step_up bigint,
  accounts_step_up_verified bigint,
  accounts_step_up_pending bigint,
  first_seen timestamptz,
  last_seen timestamptz,
  sample_user_agent text,
  account_names text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.can_view_staff_reports(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT d.device_fp,
         count(*) AS accounts,
         count(*) FILTER (WHERE d.step_up_required_at IS NOT NULL) AS accounts_needing_step_up,
         count(*) FILTER (WHERE d.step_up_verified_at IS NOT NULL) AS accounts_step_up_verified,
         count(*) FILTER (WHERE d.step_up_required_at IS NOT NULL AND d.step_up_verified_at IS NULL) AS accounts_step_up_pending,
         min(d.first_seen_at) AS first_seen,
         max(d.last_seen_at) AS last_seen,
         max(d.user_agent) AS sample_user_agent,
         string_agg(COALESCE(NULLIF(p.full_name, ''), '(no name)'), ', ' ORDER BY d.first_seen_at) AS account_names
    FROM public.login_devices d
    LEFT JOIN public.profiles p ON p.id = d.user_id
   WHERE NOT public.is_staff_account(d.user_id)
   GROUP BY d.device_fp
  HAVING count(*) >= GREATEST(p_min_accounts, 2)
   ORDER BY count(*) DESC, max(d.last_seen_at) DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END
$$;
REVOKE ALL ON FUNCTION public.get_shared_login_devices(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_shared_login_devices(integer, integer) TO authenticated;
