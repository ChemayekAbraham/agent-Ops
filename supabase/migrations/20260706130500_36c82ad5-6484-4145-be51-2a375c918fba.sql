ALTER TABLE public.fraud_identity_blocks DROP CONSTRAINT IF EXISTS fraud_identity_blocks_identifier_type_check;
ALTER TABLE public.fraud_identity_blocks ADD CONSTRAINT fraud_identity_blocks_identifier_type_check
  CHECK (identifier_type = ANY (ARRAY['user_id'::text, 'phone'::text, 'email'::text, 'mobile_money_number'::text, 'national_id'::text, 'full_name'::text]));

CREATE OR REPLACE FUNCTION public.fraud_normalize_identifier(p_type text, p_value text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
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
  ELSIF p_type = 'full_name' THEN
    RETURN btrim(regexp_replace(lower(regexp_replace(p_value, '[^A-Za-z0-9 ]', '', 'g')), '\s+', ' ', 'g'));
  END IF;
  RETURN lower(btrim(p_value));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fraud_block_user_identifiers(p_user_id uuid, p_reason text, p_blocked_by uuid DEFAULT NULL::uuid, p_extra_identifiers jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  SELECT id, full_name, email, phone, mobile_money_number, national_id
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

  IF length(public.fraud_normalize_identifier('full_name', COALESCE(p.full_name, ''))) >= 5 THEN
    INSERT INTO public.fraud_identity_blocks (identifier_type, identifier_value, normalized_value, source_user_id, reason, blocked_by, metadata)
    VALUES ('full_name', p.full_name, public.fraud_normalize_identifier('full_name', p.full_name), p_user_id, v_reason, p_blocked_by, jsonb_build_object('source','profile.full_name'))
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

  FOR v_value IN SELECT jsonb_array_elements_text(coalesce(p_extra_identifiers->'full_names', '[]'::jsonb)) LOOP
    IF length(public.fraud_normalize_identifier('full_name', COALESCE(v_value, ''))) >= 5 THEN
      INSERT INTO public.fraud_identity_blocks (identifier_type, identifier_value, normalized_value, source_user_id, reason, blocked_by, metadata)
      VALUES ('full_name', v_value, public.fraud_normalize_identifier('full_name', v_value), p_user_id, v_reason, p_blocked_by, jsonb_build_object('source','extra.full_names'))
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
$function$;

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
  v_phone_in text;
  v_full_name_in text;
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
  v_full_name_in := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data->>'full_name', '')), '');

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

  v_roles_to_assign := ARRAY[]::text[];
  IF v_intended_role IS NOT NULL THEN
    v_roles_to_assign := array_append(v_roles_to_assign, v_intended_role);
  END IF;

  INSERT INTO public.profiles (id, full_name, email, phone, referrer_id, signup_source, funder_reference)
  VALUES (
    NEW.id,
    v_full_name_in,
    NEW.email,
    v_phone_in,
    v_referrer_id,
    v_signup_source,
    v_funder_ref
  )
  ON CONFLICT (id) DO UPDATE SET
    full_name = COALESCE(EXCLUDED.full_name, public.profiles.full_name),
    email = COALESCE(EXCLUDED.email, public.profiles.email),
    phone = COALESCE(EXCLUDED.phone, public.profiles.phone);

  FOREACH v_role IN ARRAY v_roles_to_assign LOOP
    IF v_role IS NOT NULL AND v_role <> '' THEN
      INSERT INTO public.user_roles (user_id, role, enabled)
      VALUES (NEW.id, v_role::app_role, TRUE)
      ON CONFLICT (user_id, role) DO NOTHING;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_fraud_account_by_name(p_full_name text)
 RETURNS TABLE(is_blocked boolean, status text, user_id uuid, reason text, blocked_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT TRUE, b.status, b.source_user_id, b.reason, b.blocked_at
  FROM public.fraud_identity_blocks b
  WHERE b.status = 'active'
    AND b.identifier_type = 'full_name'
    AND length(public.fraud_normalize_identifier('full_name', p_full_name)) >= 5
    AND b.normalized_value = public.fraud_normalize_identifier('full_name', p_full_name)
  ORDER BY b.blocked_at DESC
  LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.check_fraud_account_by_name(text) TO anon, authenticated;

INSERT INTO public.fraud_identity_blocks (identifier_type, identifier_value, normalized_value, source_user_id, reason, metadata)
SELECT DISTINCT ON (public.fraud_normalize_identifier('full_name', p.full_name))
       'full_name', p.full_name, public.fraud_normalize_identifier('full_name', p.full_name), p.id,
       COALESCE(NULLIF(btrim(p.frozen_reason), ''), 'Fraud account: display name blocked from re-registration.'),
       jsonb_build_object('source','backfill.profile.full_name')
FROM public.profiles p
WHERE p.is_frozen = TRUE
  AND EXISTS (SELECT 1 FROM public.fraud_identity_blocks b WHERE b.source_user_id = p.id AND b.status='active')
  AND length(public.fraud_normalize_identifier('full_name', COALESCE(p.full_name, ''))) >= 5
ORDER BY public.fraud_normalize_identifier('full_name', p.full_name), p.created_at
ON CONFLICT (identifier_type, normalized_value) DO UPDATE SET status='active', released_at=NULL, released_by=NULL;