CREATE TABLE IF NOT EXISTS public.fraud_identity_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier_type text NOT NULL CHECK (identifier_type IN ('user_id','phone','email','mobile_money_number','national_id')),
  identifier_value text NOT NULL,
  normalized_value text NOT NULL,
  source_user_id uuid,
  reason text NOT NULL,
  severity text NOT NULL DEFAULT 'fraud' CHECK (severity IN ('fraud','abuse','risk')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')),
  blocked_by uuid,
  blocked_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid,
  released_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (identifier_type, normalized_value)
);

GRANT SELECT, INSERT, UPDATE ON public.fraud_identity_blocks TO authenticated;
GRANT ALL ON public.fraud_identity_blocks TO service_role;

ALTER TABLE public.fraud_identity_blocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view fraud blocks"
ON public.fraud_identity_blocks
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'operations'));

CREATE POLICY "Managers can manage fraud blocks"
ON public.fraud_identity_blocks
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin'))
WITH CHECK (public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin'));

CREATE OR REPLACE FUNCTION public.fraud_normalize_identifier(p_type text, p_value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text;
BEGIN
  IF p_value IS NULL THEN
    RETURN '';
  END IF;
  IF p_type IN ('phone','mobile_money_number') THEN
    v := regexp_replace(p_value, '[^0-9]', '', 'g');
    IF length(v) >= 9 THEN
      RETURN right(v, 9);
    END IF;
    RETURN v;
  ELSIF p_type = 'email' THEN
    RETURN lower(btrim(p_value));
  ELSIF p_type = 'user_id' THEN
    RETURN lower(btrim(p_value));
  ELSIF p_type = 'national_id' THEN
    RETURN upper(regexp_replace(p_value, '[^A-Za-z0-9]', '', 'g'));
  END IF;
  RETURN lower(btrim(p_value));
END;
$$;

GRANT EXECUTE ON FUNCTION public.fraud_normalize_identifier(text, text) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.touch_fraud_identity_blocks_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.normalized_value := public.fraud_normalize_identifier(NEW.identifier_type, NEW.identifier_value);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_fraud_identity_blocks_updated_at ON public.fraud_identity_blocks;
CREATE TRIGGER trg_touch_fraud_identity_blocks_updated_at
BEFORE INSERT OR UPDATE ON public.fraud_identity_blocks
FOR EACH ROW
EXECUTE FUNCTION public.touch_fraud_identity_blocks_updated_at();

CREATE OR REPLACE FUNCTION public.is_fraud_identifier_blocked(p_type text, p_value text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.fraud_identity_blocks b
    WHERE b.identifier_type = p_type
      AND b.status = 'active'
      AND b.normalized_value = public.fraud_normalize_identifier(p_type, p_value)
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_fraud_identifier_blocked(text, text) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fraud_block_user_identifiers(
  p_user_id uuid,
  p_reason text,
  p_blocked_by uuid DEFAULT NULL,
  p_extra_identifiers jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p record;
  v_count integer := 0;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_value text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id_required';
  END IF;
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'reason_min_10_chars';
  END IF;

  SELECT id, email, phone, mobile_money_number, national_id
    INTO p
  FROM public.profiles
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;

  INSERT INTO public.fraud_identity_blocks (identifier_type, identifier_value, normalized_value, source_user_id, reason, blocked_by, metadata)
  VALUES ('user_id', p_user_id::text, public.fraud_normalize_identifier('user_id', p_user_id::text), p_user_id, v_reason, p_blocked_by, jsonb_build_object('source','fraud_block_user_identifiers'))
  ON CONFLICT (identifier_type, normalized_value) DO UPDATE SET
    status='active', reason=EXCLUDED.reason, blocked_by=COALESCE(EXCLUDED.blocked_by, fraud_identity_blocks.blocked_by), source_user_id=COALESCE(fraud_identity_blocks.source_user_id, EXCLUDED.source_user_id), released_at=NULL, released_by=NULL, metadata=fraud_identity_blocks.metadata || EXCLUDED.metadata;
  v_count := v_count + 1;

  IF NULLIF(p.email, '') IS NOT NULL THEN
    INSERT INTO public.fraud_identity_blocks (identifier_type, identifier_value, normalized_value, source_user_id, reason, blocked_by, metadata)
    VALUES ('email', p.email, public.fraud_normalize_identifier('email', p.email), p_user_id, v_reason, p_blocked_by, jsonb_build_object('source','profile.email'))
    ON CONFLICT (identifier_type, normalized_value) DO UPDATE SET
      status='active', reason=EXCLUDED.reason, blocked_by=COALESCE(EXCLUDED.blocked_by, fraud_identity_blocks.blocked_by), source_user_id=COALESCE(fraud_identity_blocks.source_user_id, EXCLUDED.source_user_id), released_at=NULL, released_by=NULL, metadata=fraud_identity_blocks.metadata || EXCLUDED.metadata;
    v_count := v_count + 1;
  END IF;

  IF NULLIF(p.phone, '') IS NOT NULL THEN
    INSERT INTO public.fraud_identity_blocks (identifier_type, identifier_value, normalized_value, source_user_id, reason, blocked_by, metadata)
    VALUES ('phone', p.phone, public.fraud_normalize_identifier('phone', p.phone), p_user_id, v_reason, p_blocked_by, jsonb_build_object('source','profile.phone'))
    ON CONFLICT (identifier_type, normalized_value) DO UPDATE SET
      status='active', reason=EXCLUDED.reason, blocked_by=COALESCE(EXCLUDED.blocked_by, fraud_identity_blocks.blocked_by), source_user_id=COALESCE(fraud_identity_blocks.source_user_id, EXCLUDED.source_user_id), released_at=NULL, released_by=NULL, metadata=fraud_identity_blocks.metadata || EXCLUDED.metadata;
    v_count := v_count + 1;
  END IF;

  IF NULLIF(p.mobile_money_number, '') IS NOT NULL THEN
    INSERT INTO public.fraud_identity_blocks (identifier_type, identifier_value, normalized_value, source_user_id, reason, blocked_by, metadata)
    VALUES ('mobile_money_number', p.mobile_money_number, public.fraud_normalize_identifier('mobile_money_number', p.mobile_money_number), p_user_id, v_reason, p_blocked_by, jsonb_build_object('source','profile.mobile_money_number'))
    ON CONFLICT (identifier_type, normalized_value) DO UPDATE SET
      status='active', reason=EXCLUDED.reason, blocked_by=COALESCE(EXCLUDED.blocked_by, fraud_identity_blocks.blocked_by), source_user_id=COALESCE(fraud_identity_blocks.source_user_id, EXCLUDED.source_user_id), released_at=NULL, released_by=NULL, metadata=fraud_identity_blocks.metadata || EXCLUDED.metadata;
    v_count := v_count + 1;
  END IF;

  IF NULLIF(p.national_id, '') IS NOT NULL THEN
    INSERT INTO public.fraud_identity_blocks (identifier_type, identifier_value, normalized_value, source_user_id, reason, blocked_by, metadata)
    VALUES ('national_id', p.national_id, public.fraud_normalize_identifier('national_id', p.national_id), p_user_id, v_reason, p_blocked_by, jsonb_build_object('source','profile.national_id'))
    ON CONFLICT (identifier_type, normalized_value) DO UPDATE SET
      status='active', reason=EXCLUDED.reason, blocked_by=COALESCE(EXCLUDED.blocked_by, fraud_identity_blocks.blocked_by), source_user_id=COALESCE(fraud_identity_blocks.source_user_id, EXCLUDED.source_user_id), released_at=NULL, released_by=NULL, metadata=fraud_identity_blocks.metadata || EXCLUDED.metadata;
    v_count := v_count + 1;
  END IF;

  FOR v_value IN SELECT jsonb_array_elements_text(coalesce(p_extra_identifiers->'phones', '[]'::jsonb)) LOOP
    IF NULLIF(v_value, '') IS NOT NULL THEN
      INSERT INTO public.fraud_identity_blocks (identifier_type, identifier_value, normalized_value, source_user_id, reason, blocked_by, metadata)
      VALUES ('phone', v_value, public.fraud_normalize_identifier('phone', v_value), p_user_id, v_reason, p_blocked_by, jsonb_build_object('source','extra.phones'))
      ON CONFLICT (identifier_type, normalized_value) DO UPDATE SET
        status='active', reason=EXCLUDED.reason, blocked_by=COALESCE(EXCLUDED.blocked_by, fraud_identity_blocks.blocked_by), source_user_id=COALESCE(fraud_identity_blocks.source_user_id, EXCLUDED.source_user_id), released_at=NULL, released_by=NULL, metadata=fraud_identity_blocks.metadata || EXCLUDED.metadata;
      v_count := v_count + 1;
    END IF;
  END LOOP;

  FOR v_value IN SELECT jsonb_array_elements_text(coalesce(p_extra_identifiers->'mobile_money_numbers', '[]'::jsonb)) LOOP
    IF NULLIF(v_value, '') IS NOT NULL THEN
      INSERT INTO public.fraud_identity_blocks (identifier_type, identifier_value, normalized_value, source_user_id, reason, blocked_by, metadata)
      VALUES ('mobile_money_number', v_value, public.fraud_normalize_identifier('mobile_money_number', v_value), p_user_id, v_reason, p_blocked_by, jsonb_build_object('source','extra.mobile_money_numbers'))
      ON CONFLICT (identifier_type, normalized_value) DO UPDATE SET
        status='active', reason=EXCLUDED.reason, blocked_by=COALESCE(EXCLUDED.blocked_by, fraud_identity_blocks.blocked_by), source_user_id=COALESCE(fraud_identity_blocks.source_user_id, EXCLUDED.source_user_id), released_at=NULL, released_by=NULL, metadata=fraud_identity_blocks.metadata || EXCLUDED.metadata;
      v_count := v_count + 1;
    END IF;
  END LOOP;

  FOR v_value IN SELECT jsonb_array_elements_text(coalesce(p_extra_identifiers->'emails', '[]'::jsonb)) LOOP
    IF NULLIF(v_value, '') IS NOT NULL THEN
      INSERT INTO public.fraud_identity_blocks (identifier_type, identifier_value, normalized_value, source_user_id, reason, blocked_by, metadata)
      VALUES ('email', v_value, public.fraud_normalize_identifier('email', v_value), p_user_id, v_reason, p_blocked_by, jsonb_build_object('source','extra.emails'))
      ON CONFLICT (identifier_type, normalized_value) DO UPDATE SET
        status='active', reason=EXCLUDED.reason, blocked_by=COALESCE(EXCLUDED.blocked_by, fraud_identity_blocks.blocked_by), source_user_id=COALESCE(fraud_identity_blocks.source_user_id, EXCLUDED.source_user_id), released_at=NULL, released_by=NULL, metadata=fraud_identity_blocks.metadata || EXCLUDED.metadata;
      v_count := v_count + 1;
    END IF;
  END LOOP;

  UPDATE public.profiles
  SET is_frozen = TRUE,
      frozen_reason = v_reason,
      frozen_at = COALESCE(frozen_at, now()),
      tenant_status = CASE WHEN tenant_status IS NULL THEN tenant_status ELSE 'inactive' END,
      updated_at = now()
  WHERE id = p_user_id;

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES ('account_flagged', p_user_id, 'profiles', p_user_id, jsonb_build_object('reason', v_reason, 'flag_type', 'fraud', 'blocked_identifiers', v_count));

  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  VALUES (COALESCE(p_blocked_by, p_user_id), 'fraud_account_blocked', 'fraud_account_blocked', 'profiles', p_user_id::text, jsonb_build_object('reason', v_reason, 'blocked_identifiers', v_count));

  RETURN jsonb_build_object('ok', true, 'blocked_identifiers', v_count);
END;
$$;

GRANT EXECUTE ON FUNCTION public.fraud_block_user_identifiers(uuid, text, uuid, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.check_fraud_account_by_phone(phone_variants text[])
RETURNS TABLE(is_blocked boolean, status text, user_id uuid, full_name text, reason text, blocked_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  last9_variants text[] := ARRAY[]::text[];
  v text;
  cleaned text;
BEGIN
  FOREACH v IN ARRAY phone_variants LOOP
    cleaned := public.fraud_normalize_identifier('phone', v);
    IF cleaned <> '' THEN
      last9_variants := array_append(last9_variants, cleaned);
    END IF;
  END LOOP;

  RETURN QUERY
  SELECT TRUE, b.status, b.source_user_id, p.full_name, b.reason, b.blocked_at
  FROM public.fraud_identity_blocks b
  LEFT JOIN public.profiles p ON p.id = b.source_user_id
  WHERE b.status = 'active'
    AND b.identifier_type IN ('phone','mobile_money_number')
    AND b.normalized_value = ANY(last9_variants)
  ORDER BY b.blocked_at DESC
  LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_fraud_account_by_phone(text[]) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.check_fraud_account_by_email(p_email text)
RETURNS TABLE(is_blocked boolean, status text, user_id uuid, full_name text, reason text, blocked_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT TRUE, b.status, b.source_user_id, p.full_name, b.reason, b.blocked_at
  FROM public.fraud_identity_blocks b
  LEFT JOIN public.profiles p ON p.id = b.source_user_id
  WHERE b.status = 'active'
    AND b.identifier_type = 'email'
    AND b.normalized_value = public.fraud_normalize_identifier('email', p_email)
  ORDER BY b.blocked_at DESC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.check_fraud_account_by_email(text) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_email_by_phone(phone_variants text[])
RETURNS TABLE(email text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  last9_variants text[];
  v text;
  cleaned text;
BEGIN
  last9_variants := ARRAY[]::text[];

  FOREACH v IN ARRAY phone_variants LOOP
    cleaned := regexp_replace(COALESCE(v, ''), '[^0-9]', '', 'g');
    IF length(cleaned) >= 9 THEN
      last9_variants := array_append(last9_variants, right(cleaned, 9));
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM public.fraud_identity_blocks b
    WHERE b.status = 'active'
      AND b.identifier_type IN ('phone','mobile_money_number')
      AND b.normalized_value = ANY(last9_variants)
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH matched_profiles AS (
    SELECT
      p.id,
      p.email AS profile_email,
      p.phone AS profile_phone,
      p.full_name,
      p.updated_at AS profile_updated_at,
      u.email AS auth_email,
      u.phone AS auth_phone,
      u.deleted_at AS auth_deleted_at,
      u.updated_at AS auth_updated_at
    FROM public.profiles p
    LEFT JOIN auth.users u ON u.id = p.id
    WHERE (
      right(regexp_replace(COALESCE(p.phone, ''), '[^0-9]', '', 'g'), 9) = ANY(last9_variants)
      OR right(regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g'), 9) = ANY(last9_variants)
    )
    AND COALESCE(p.full_name, '') NOT ILIKE '[ARCHIVED]%'
    AND COALESCE(p.is_frozen, FALSE) = FALSE
    AND NOT EXISTS (
      SELECT 1 FROM public.fraud_identity_blocks b
      WHERE b.status = 'active'
        AND (
          (b.identifier_type = 'user_id' AND b.normalized_value = public.fraud_normalize_identifier('user_id', p.id::text)) OR
          (b.identifier_type = 'email' AND b.normalized_value IN (public.fraud_normalize_identifier('email', p.email), public.fraud_normalize_identifier('email', u.email))) OR
          (b.identifier_type IN ('phone','mobile_money_number') AND b.normalized_value IN (public.fraud_normalize_identifier('phone', p.phone), public.fraud_normalize_identifier('phone', u.phone)))
        )
    )
    AND (u.id IS NULL OR u.deleted_at IS NULL)
  ), candidate_emails AS (
    SELECT lower(auth_email) AS candidate_email, 0 AS priority, COALESCE(auth_updated_at, profile_updated_at) AS last_seen
    FROM matched_profiles
    WHERE NULLIF(auth_email, '') IS NOT NULL

    UNION ALL

    SELECT lower(profile_email) AS candidate_email, 1 AS priority, profile_updated_at AS last_seen
    FROM matched_profiles
    WHERE NULLIF(profile_email, '') IS NOT NULL
  )
  SELECT candidate_email
  FROM candidate_emails
  WHERE candidate_email IS NOT NULL
    AND candidate_email <> ''
    AND candidate_email NOT LIKE 'freed+%@archived.local'
  GROUP BY candidate_email
  ORDER BY min(priority), max(last_seen) DESC NULLS LAST
  LIMIT 10;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_email_by_phone(text[]) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  IF v_intended_role IS NULL THEN
    v_intended_role := NULLIF(NEW.raw_user_meta_data->>'role', '');
  END IF;
  v_signup_source := NULLIF(NEW.raw_user_meta_data->>'signup_source', '');
  v_phone_in := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data->>'phone', '')), '');

  IF public.is_fraud_identifier_blocked('user_id', NEW.id::text)
     OR (NEW.email IS NOT NULL AND public.is_fraud_identifier_blocked('email', NEW.email))
     OR (v_phone_in IS NOT NULL AND public.is_fraud_identifier_blocked('phone', v_phone_in))
     OR (v_phone_in IS NOT NULL AND public.is_fraud_identifier_blocked('mobile_money_number', v_phone_in)) THEN
    RAISE EXCEPTION 'fraud_blocked_identifier: this phone/email is permanently restricted from Welile signup'
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