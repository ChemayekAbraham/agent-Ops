CREATE OR REPLACE FUNCTION public.complete_campaign_attribution_for_user(
  p_token text,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_attr public.campaign_attributions;
  v_link public.recruitment_campaign_links;
  v_camp_status public.recruitment_campaign_status;
  v_is_sub boolean;
  v_existing_reg uuid;
  v_completed_by_this_user uuid;
  v_link_result jsonb;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('status','no_user');
  END IF;
  IF p_token IS NULL OR length(p_token) < 8 THEN
    RETURN jsonb_build_object('status','invalid_token');
  END IF;

  SELECT * INTO v_attr
  FROM public.campaign_attributions
  WHERE attribution_token = p_token;

  IF v_attr.id IS NULL THEN
    RETURN jsonb_build_object('status','invalid_token');
  END IF;

  IF v_attr.status = 'registration_completed' AND v_attr.registered_user_id = p_user_id THEN
    v_link_result := public.link_campaign_sub_agent(p_user_id);
    RETURN jsonb_build_object('status','already_completed','attribution_id',v_attr.id,'sub_agent_link',v_link_result);
  END IF;

  IF v_attr.status = 'registration_completed' THEN
    RETURN jsonb_build_object('status','already_completed_other_user');
  END IF;

  IF v_attr.expires_at <= now() THEN
    UPDATE public.campaign_attributions
       SET status = 'expired'
     WHERE id = v_attr.id
       AND status <> 'expired';
    RETURN jsonb_build_object('status','expired');
  END IF;

  SELECT * INTO v_link
  FROM public.recruitment_campaign_links
  WHERE id = v_attr.campaign_link_id;

  IF v_link.id IS NULL OR v_link.status <> 'active' THEN
    RETURN jsonb_build_object('status','link_inactive');
  END IF;

  SELECT status INTO v_camp_status
  FROM public.recruitment_campaigns
  WHERE id = v_attr.campaign_id;

  IF v_camp_status <> 'active' THEN
    RETURN jsonb_build_object('status','campaign_inactive');
  END IF;

  IF p_user_id = v_attr.referring_agent_id THEN
    UPDATE public.campaign_attributions
       SET status = 'invalidated'
     WHERE id = v_attr.id;
    RETURN jsonb_build_object('status','self_referral_blocked');
  END IF;

  SELECT id INTO v_existing_reg
  FROM public.recruitment_campaign_registrations
  WHERE registered_user_id = p_user_id
  ORDER BY registered_at DESC
  LIMIT 1;

  IF v_existing_reg IS NOT NULL THEN
    UPDATE public.campaign_attributions
       SET status = 'existing_user',
           locked_at = COALESCE(locked_at, now()),
           registered_user_id = COALESCE(registered_user_id, p_user_id)
     WHERE id = v_attr.id;

    INSERT INTO public.campaign_attribution_audit_logs(attribution_id, action, reason, actor_type, actor_id)
    VALUES (v_attr.id, 'duplicate_registration_detected', 'user has prior attribution', 'user', p_user_id);

    v_link_result := public.link_campaign_sub_agent(p_user_id);
    RETURN jsonb_build_object('status','already_attributed','registration_id',v_existing_reg,'sub_agent_link',v_link_result);
  END IF;

  v_is_sub := public.has_role(p_user_id, 'agent');

  INSERT INTO public.recruitment_campaign_registrations(
    campaign_link_id,
    campaign_id,
    agent_id,
    registered_user_id,
    location_id,
    selected_source,
    is_sub_agent,
    qualification_status
  ) VALUES (
    v_link.id,
    v_link.campaign_id,
    v_link.agent_id,
    p_user_id,
    v_link.location_id,
    v_link.selected_source,
    v_is_sub,
    CASE WHEN v_is_sub THEN 'active'::public.recruitment_registration_status ELSE 'registered'::public.recruitment_registration_status END
  )
  RETURNING id INTO v_completed_by_this_user;

  UPDATE public.recruitment_campaign_links
     SET total_registrations = total_registrations + 1
   WHERE id = v_link.id;

  IF v_attr.anonymous_visitor_id IS NOT NULL THEN
    UPDATE public.recruitment_campaign_clicks
       SET converted_to_registration = true
     WHERE campaign_link_id = v_link.id
       AND visitor_id = v_attr.anonymous_visitor_id;
  END IF;

  BEGIN
    UPDATE public.profiles
       SET referrer_id = v_link.agent_id
     WHERE id = p_user_id
       AND referrer_id IS NULL;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  UPDATE public.campaign_attributions
     SET status = 'registration_completed',
         registration_completed_at = now(),
         locked_at = COALESCE(locked_at, now()),
         registered_user_id = p_user_id
   WHERE id = v_attr.id;

  INSERT INTO public.campaign_attribution_audit_logs(attribution_id, action, reason, actor_type, actor_id)
  VALUES (v_attr.id, 'registration_completed', 'signup finalized', 'user', p_user_id);

  DELETE FROM public.sub_agent_registration_drafts
  WHERE attribution_id = v_attr.id;

  v_link_result := public.link_campaign_sub_agent(p_user_id);

  RETURN jsonb_build_object(
    'status','ok',
    'attribution_id', v_attr.id,
    'link_id', v_link.id,
    'agent_id', v_link.agent_id,
    'is_sub_agent', v_is_sub,
    'sub_agent_link', v_link_result
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_campaign_attribution_for_user(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_campaign_attribution_for_user(text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_campaign_attribution(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('status','auth_required');
  END IF;

  RETURN public.complete_campaign_attribution_for_user(p_token, v_uid);
END;
$$;

REVOKE ALL ON FUNCTION public.complete_campaign_attribution(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_campaign_attribution(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
$$;