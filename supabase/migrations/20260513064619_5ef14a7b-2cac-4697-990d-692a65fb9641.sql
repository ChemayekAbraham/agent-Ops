CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_referrer_id_raw text;
  v_referrer_id  uuid;
  v_referrer_valid boolean := FALSE;
  v_intended_role text;
  v_signup_source text;
  v_funder_ref text;
  v_referrer_is_agent boolean := FALSE;
  v_phone_in text;
  v_phone_taken_by uuid;
  v_roles_to_assign text[];
  v_role text;
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
  -- Also accept 'role' metadata key (used by email/password signUp flow)
  IF v_intended_role IS NULL THEN
    v_intended_role := NULLIF(NEW.raw_user_meta_data->>'role', '');
  END IF;
  v_signup_source := NULLIF(NEW.raw_user_meta_data->>'signup_source', '');
  v_phone_in := COALESCE(NEW.raw_user_meta_data->>'phone', '');

  IF v_signup_source = 'funder-onboarding' THEN
    v_funder_ref := public.build_funder_reference(NEW.id, NEW.created_at);
  ELSE
    v_funder_ref := NULL;
  END IF;

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

  -- ============================================================
  -- DEFAULT ROLE ENFORCEMENT (covers OAuth bypass of /select-role)
  -- If a specific public role was requested, assign only that.
  -- Otherwise grant all 4 public roles so the account is never
  -- stuck on the role-picker with zero permissions.
  -- ============================================================
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
$function$;

-- Backfill: any existing user with a profile but no roles gets the 4 public roles.
INSERT INTO public.user_roles (user_id, role, enabled)
SELECT p.id, r.role::app_role, TRUE
FROM public.profiles p
CROSS JOIN (VALUES ('agent'),('tenant'),('landlord'),('supporter')) AS r(role)
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id
)
ON CONFLICT (user_id, role) DO NOTHING;