-- Harden the signup-velocity guard added in 20260914150000, per Josh's
-- explicit request to make it as hard as possible to repeat the referral-bonus
-- bot-signup ring (docs/HANDOVER/21-referral-bonus-bot-signup-fraud-ring.md).
--
-- Old cap: 15 signups/hour from the same referral link.
-- New cap: 5/hour OR 10/24-hours (dual window) -- the same standard already
-- trusted in production for the agent-assisted registration paths
-- (record_agent_assisted_signup: 5/hour, 15/day).
--
-- Legitimate high-volume agent recruitment is unaffected: those flows
-- (register-tenant, submit-tenant-form) create the auth user via
-- auth.admin.createUser() without referrer_id in raw_user_meta_data, so this
-- branch of handle_new_user() never runs for them -- they have their own
-- separate, already-tightened caps (see 20260914160000).
--
-- See docs/HANDOVER/22-signup-entry-points-hardening.md.

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

  INSERT INTO public.profiles (id, email, full_name, phone, referrer_id, signup_source, funder_reference)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    v_phone_in,
    v_referrer_id,
    v_signup_source,
    v_funder_ref
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), profiles.full_name),
    phone = COALESCE(EXCLUDED.phone, profiles.phone),
    referrer_id = COALESCE(EXCLUDED.referrer_id, profiles.referrer_id),
    signup_source = COALESCE(profiles.signup_source, EXCLUDED.signup_source),
    funder_reference = COALESCE(profiles.funder_reference, EXCLUDED.funder_reference),
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
