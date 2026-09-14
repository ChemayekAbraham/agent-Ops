-- Follow-up to 20260914140000/141000 (referral-bonus bot-signup fraud ring).
--
-- Two things happened after the first fix went live:
--
-- 1. The ring was bigger than first measured. Auditing every account with
--    10+ `referral_bonus` ledger credits (not just the ones the CTO
--    dashboard's `burst_signup` heuristic had already flagged) surfaced two
--    more referrer accounts running the identical pattern (400 bonuses /
--    UGX 40,000 each), for 19 confirmed referrers total, and ~7,859
--    additional bot accounts under them that `burst_signup` had missed
--    entirely -- that heuristic only fires on 10+ signups in the SAME
--    10-minute bucket, so a slower drip (one signup every ~1-2 minutes for
--    hours) evades it even though the referrer and the near-duplicate
--    email/phone pattern are identical. Total exposure across all 19:
--    UGX 3,362,700 paid, UGX 3,172,500 already withdrawn, UGX 320,800
--    recovered by freezing before it could be cashed out.
--
-- 2. Freezing a referrer's own account (blocks their withdrawals) does
--    NOT stop their signup script from continuing to create new referred
--    bot accounts -- one already-frozen referrer (fc7837ea...) kept
--    producing new bot signups for hours after being frozen. The root
--    cause fix in 20260914140000 already made this financially pointless
--    (no bonus qualifies on bare signup anymore), but the accounts kept
--    being created, cluttering the platform and burning through the
--    signup pipeline.
--
-- This migration:
--   a) Adds a signup-velocity guard directly to `handle_new_user()` --
--      the trigger that fires on every `auth.users` insert regardless of
--      which client called it. 15+ signups from the same referrer_id in
--      the last hour is rejected outright. This is deliberately at the
--      trigger level, not just app code, because it fires no matter how
--      the account was created -- including a script hitting Supabase
--      Auth's public /auth/v1/signup endpoint directly, which is exactly
--      how a client-side-only check like signupGuard.ts's preflightSignup()
--      gets bypassed.
--   b) Freezes the 2 newly-found referrer accounts the same way as the
--      original 17 (fraud_block_user_identifiers).
--   c) Soft-deletes the ~7,859 additional bot accounts referred by any of
--      the 19 confirmed-fraud referrers (matched by referrer_id identity,
--      not by the burst_signup heuristic, since that's what missed them).
--
-- See docs/HANDOVER/21-referral-bonus-bot-signup-fraud-ring.md.

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
  v_recent_referred_count int := 0;
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

  -- Signup-velocity guard: a referral link that has produced 15+ new signups
  -- in the last hour is a bot ring, not a real referral burst (confirmed
  -- 2026-09-14: 19 referrer accounts drove 33,000+ throwaway signups this
  -- way to farm referral bonuses). Reject outright rather than let the
  -- account get created and clean it up after -- this fires as a trigger on
  -- auth.users itself, so it cannot be bypassed by calling the Auth REST
  -- endpoint directly the way the client-side signupGuard.ts check can be.
  -- See docs/HANDOVER/21-referral-bonus-bot-signup-fraud-ring.md.
  IF v_referrer_id IS NOT NULL THEN
    SELECT count(*) INTO v_recent_referred_count
    FROM public.profiles
    WHERE referrer_id = v_referrer_id
      AND created_at > now() - interval '1 hour';

    IF v_recent_referred_count >= 15 THEN
      RAISE EXCEPTION 'signup_velocity_blocked: too many signups from this referral link recently; please try again later'
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

DO $$
DECLARE
  v_actor uuid := 'cb798acb-68bc-4b4e-a414-a3d374e030b6';
  v_reason text := 'Referral-bonus bot-signup fraud ring (same pattern as the original 17): 400 UGX-100 referral bonuses each from near-duplicate throwaway signups. Confirmed 2026-09-14.';
BEGIN
  PERFORM public.fraud_block_user_identifiers('3c10e56c-15f9-4b8e-97a4-cf1dc51361c1', v_reason, v_actor);
  PERFORM public.fraud_block_user_identifiers('c775dcc8-cd43-425d-adeb-e8a955412a5b', v_reason, v_actor);
END $$;

CREATE TEMP TABLE tmp_bot_ids AS
SELECT p.id AS user_id
FROM public.profiles p
LEFT JOIN auth.users u ON u.id = p.id
WHERE p.deleted_at IS NULL
  AND p.referrer_id = ANY(ARRAY[
    'c1ebb2b0-6d8e-4aff-9d0c-17adb1a6ff6e','fc7837ea-526a-4511-bd3a-8c37ed60ebf9',
    '52d458f7-a3dd-4d4e-8d0e-6b4714a6879e','ee02ff74-3ec8-4472-89b2-ff2f1b9254d9',
    '819f717f-6c66-47a8-8da8-606beedaf192','2ae6c920-f77a-4eec-a84d-5dd8f651fcde',
    '4d21fe5b-38c9-4b5e-8c93-6b9cca9aae7b','dd6bdec3-3317-4543-9269-759d0086a117',
    '40341d55-5af5-4dfc-a6bc-3d34e60413b1','a5ee56eb-473f-404e-82ba-ac7d71afa359',
    'd981be9a-8c4d-435e-bc2b-1ecf7a1578d9','fa5835e4-32f2-42cd-97f4-caa4717a9a78',
    '1e3babbf-fccb-44c8-9e92-d58711020b06','bbef3c10-5ac7-4091-98b7-291e0a3d3f07',
    '39d7f264-d111-478a-9905-4a76ea8801d1','f5994e00-af24-4a25-a1de-fc22a214381f',
    'fb7762d5-85eb-4411-876e-a0c4bc6ad4e2',
    '3c10e56c-15f9-4b8e-97a4-cf1dc51361c1','c775dcc8-cd43-425d-adeb-e8a955412a5b'
  ]::uuid[])
  AND u.email_confirmed_at IS NULL;

CREATE TEMP TABLE tmp_bot_snapshot AS
SELECT p.id AS user_id, p.full_name, p.email, p.phone, p.national_id
FROM public.profiles p
JOIN tmp_bot_ids t ON t.user_id = p.id;

CREATE TEMP TABLE tmp_bot_roles AS
SELECT ur.user_id, jsonb_agg(jsonb_build_object('role', ur.role, 'enabled', true)) AS roles
FROM public.user_roles ur
JOIN tmp_bot_ids t ON t.user_id = ur.user_id
GROUP BY ur.user_id;

INSERT INTO public.deleted_accounts (user_id, full_name, email, phone, national_id, roles, status, reason, deleted_by)
SELECT s.user_id, s.full_name, s.email, s.phone, s.national_id,
       COALESCE(r.roles, '[]'::jsonb), 'soft_deleted',
       'Confirmed bot signup: referred by a known referral-bonus fraud ring account (unconfirmed email). Remediated 2026-09-14 (extended sweep); see docs/HANDOVER/21-referral-bonus-bot-signup-fraud-ring.md.',
       'cb798acb-68bc-4b4e-a414-a3d374e030b6'
FROM tmp_bot_snapshot s
LEFT JOIN tmp_bot_roles r ON r.user_id = s.user_id;

DELETE FROM public.user_roles WHERE user_id IN (SELECT user_id FROM tmp_bot_ids);
DELETE FROM public.push_subscriptions WHERE user_id IN (SELECT user_id FROM tmp_bot_ids);

UPDATE public.profiles p SET
  full_name = CASE WHEN p.full_name LIKE '[DELETED]%' THEN p.full_name ELSE '[DELETED] ' || COALESCE(p.full_name,'Account') END,
  previous_full_name = COALESCE(p.previous_full_name, p.full_name),
  email = 'deleted+' || p.id::text || '@deleted.invalid',
  phone = NULL,
  national_id = NULL,
  mobile_money_number = NULL,
  is_frozen = true,
  frozen_at = COALESCE(p.frozen_at, now()),
  frozen_reason = 'Account deleted: confirmed bot signup referred by known fraud ring account, 2026-09-14 extended remediation',
  deleted_at = now(),
  deleted_by = 'cb798acb-68bc-4b4e-a414-a3d374e030b6',
  deletion_reason = 'Confirmed bot signup: referred by a known referral-bonus fraud ring account. Remediated 2026-09-14 (extended sweep).'
FROM tmp_bot_snapshot s
WHERE p.id = s.user_id;

INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
SELECT 'cb798acb-68bc-4b4e-a414-a3d374e030b6', 'soft_delete_account', 'soft_delete_account', 'profiles', user_id::text,
  jsonb_build_object(
    'reason','Confirmed bot signup, referred by known fraud ring account, 2026-09-14 extended bulk remediation',
    'performed_by','cb798acb-68bc-4b4e-a414-a3d374e030b6',
    'bulk_remediation', true
  )
FROM tmp_bot_snapshot;

DROP TABLE tmp_bot_ids;
DROP TABLE tmp_bot_snapshot;
DROP TABLE tmp_bot_roles;
