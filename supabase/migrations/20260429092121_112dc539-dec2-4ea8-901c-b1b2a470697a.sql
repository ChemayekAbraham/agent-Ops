
CREATE OR REPLACE FUNCTION public.backfill_missing_profile_by_email(_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user RECORD;
  v_full_name text;
  v_phone text;
  v_signup_source text;
  v_funder_ref text;
  v_existing uuid;
  v_phone_taken_by uuid;
  v_phone_used text;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'manager') THEN
    RAISE EXCEPTION 'Only managers can backfill profiles';
  END IF;

  SELECT id, email, raw_user_meta_data, created_at
    INTO v_user
  FROM auth.users
  WHERE lower(email) = lower(trim(_email))
  LIMIT 1;

  IF v_user.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'auth_user_not_found');
  END IF;

  SELECT id INTO v_existing FROM public.profiles WHERE id = v_user.id;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'profile_already_exists', 'user_id', v_user.id);
  END IF;

  v_full_name     := COALESCE(NULLIF(v_user.raw_user_meta_data->>'full_name',''), split_part(v_user.email,'@',1));
  v_phone         := COALESCE(NULLIF(v_user.raw_user_meta_data->>'phone',''), '');
  v_signup_source := NULLIF(v_user.raw_user_meta_data->>'signup_source','');

  IF v_signup_source = 'funder-onboarding' THEN
    v_funder_ref := public.build_funder_reference(v_user.id, v_user.created_at);
  ELSE
    v_funder_ref := NULL;
  END IF;

  -- Detect phone collision and substitute a deterministic placeholder so the row can be created
  v_phone_used := v_phone;
  IF v_phone IS NOT NULL AND length(v_phone) > 0 THEN
    SELECT id INTO v_phone_taken_by
    FROM public.profiles
    WHERE normalize_phone_last9(phone) = normalize_phone_last9(v_phone)
    LIMIT 1;
    IF v_phone_taken_by IS NOT NULL THEN
      v_phone_used := 'orphan-' || substring(v_user.id::text, 1, 8) || '@welile.user';
    END IF;
  END IF;

  INSERT INTO public.profiles (id, email, full_name, phone, signup_source, funder_reference)
  VALUES (v_user.id, v_user.email, v_full_name, v_phone_used, v_signup_source, v_funder_ref);

  INSERT INTO public.user_roles (user_id, role)
  VALUES (v_user.id, 'supporter')
  ON CONFLICT (user_id, role) DO NOTHING;

  INSERT INTO public.wallets (user_id, balance)
  VALUES (v_user.id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN jsonb_build_object(
    'ok', true,
    'reason', 'profile_backfilled',
    'user_id', v_user.id,
    'signup_source', v_signup_source,
    'funder_reference', v_funder_ref,
    'phone_substituted', v_phone_used IS DISTINCT FROM v_phone,
    'phone_taken_by', v_phone_taken_by
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_missing_profile_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.backfill_missing_profile_by_email(text) TO authenticated, service_role;

-- Run the backfill for the reported test user
SELECT public.backfill_missing_profile_by_email('techworldinfo94@gmail.com');

-- Harden the new-user trigger so phone collisions raise (instead of being swallowed)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_referrer_id  uuid;
  v_intended_role text;
  v_signup_source text;
  v_funder_ref text;
  v_referrer_is_agent boolean := FALSE;
  v_phone_in text;
  v_phone_taken_by uuid;
BEGIN
  v_referrer_id := NULLIF(NEW.raw_user_meta_data->>'referrer_id', '')::uuid;
  v_intended_role := NULLIF(NEW.raw_user_meta_data->>'intended_role', '');
  v_signup_source := NULLIF(NEW.raw_user_meta_data->>'signup_source', '');
  v_phone_in := COALESCE(NEW.raw_user_meta_data->>'phone', '');

  IF v_signup_source = 'funder-onboarding' THEN
    v_funder_ref := public.build_funder_reference(NEW.id, NEW.created_at);
  ELSE
    v_funder_ref := NULL;
  END IF;

  -- Pre-check phone collision so we can raise a CLIENT-FACING error rather than fail silently.
  IF v_phone_in <> '' THEN
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
    phone = COALESCE(NULLIF(EXCLUDED.phone, ''), profiles.phone),
    referrer_id = COALESCE(EXCLUDED.referrer_id, profiles.referrer_id),
    signup_source = COALESCE(profiles.signup_source, EXCLUDED.signup_source),
    funder_reference = COALESCE(profiles.funder_reference, EXCLUDED.funder_reference),
    updated_at = now();

  IF v_intended_role = 'agent' AND v_referrer_id IS NOT NULL AND v_referrer_id <> NEW.id THEN
    BEGIN
      SELECT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = v_referrer_id AND role = 'agent'
      ) INTO v_referrer_is_agent;

      IF v_referrer_is_agent THEN
        INSERT INTO public.agent_subagents (parent_agent_id, sub_agent_id, source, status)
        VALUES (v_referrer_id, NEW.id, 'link_signup', 'verified')
        ON CONFLICT (sub_agent_id) DO NOTHING;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'handle_new_user AGENT LINK failed for %: % / SQLSTATE=%', NEW.id, SQLERRM, SQLSTATE;
    END;
  END IF;

  RETURN NEW;
END;
$$;
