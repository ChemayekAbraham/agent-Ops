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

  -- Sweep every phone / mobile-money number this user ever used for payouts.
  -- Phone is the identifier a fraudster cannot change, so we block ALL of them:
  -- profile numbers (above) plus withdrawal-request and saved-payout destinations.
  FOR v_value IN
    SELECT DISTINCT n FROM (
      SELECT public.fraud_normalize_identifier('mobile_money_number', wr.mobile_money_number) AS n
      FROM public.withdrawal_requests wr
      WHERE wr.user_id = p_user_id AND NULLIF(btrim(wr.mobile_money_number), '') IS NOT NULL
      UNION
      SELECT public.fraud_normalize_identifier('mobile_money_number', spm.momo_number) AS n
      FROM public.saved_payout_methods spm
      WHERE spm.user_id = p_user_id AND NULLIF(btrim(spm.momo_number), '') IS NOT NULL
    ) s
    WHERE length(n) >= 9
  LOOP
    INSERT INTO public.fraud_identity_blocks (identifier_type, identifier_value, normalized_value, source_user_id, reason, blocked_by, metadata)
    VALUES ('mobile_money_number', v_value, v_value, p_user_id, v_reason, p_blocked_by, jsonb_build_object('source','payout_history'))
    ON CONFLICT (identifier_type, normalized_value) DO UPDATE SET
      status='active', reason=EXCLUDED.reason, blocked_by=COALESCE(EXCLUDED.blocked_by, fraud_identity_blocks.blocked_by), source_user_id=COALESCE(fraud_identity_blocks.source_user_id, EXCLUDED.source_user_id), released_at=NULL, released_by=NULL, metadata=fraud_identity_blocks.metadata || EXCLUDED.metadata;
    v_count := v_count + 1;

    INSERT INTO public.fraud_identity_blocks (identifier_type, identifier_value, normalized_value, source_user_id, reason, blocked_by, metadata)
    VALUES ('phone', v_value, v_value, p_user_id, v_reason, p_blocked_by, jsonb_build_object('source','payout_history'))
    ON CONFLICT (identifier_type, normalized_value) DO UPDATE SET
      status='active', reason=EXCLUDED.reason, blocked_by=COALESCE(EXCLUDED.blocked_by, fraud_identity_blocks.blocked_by), source_user_id=COALESCE(fraud_identity_blocks.source_user_id, EXCLUDED.source_user_id), released_at=NULL, released_by=NULL, metadata=fraud_identity_blocks.metadata || EXCLUDED.metadata;
    v_count := v_count + 1;
  END LOOP;

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

-- Backfill: sweep historical payout phones for accounts already flagged as fraud.
INSERT INTO public.fraud_identity_blocks (identifier_type, identifier_value, normalized_value, source_user_id, reason, metadata)
SELECT t.itype, t.n, t.n, t.user_id,
       'Fraud account: historical payout number blocked from reuse.',
       jsonb_build_object('source','backfill.payout_history')
FROM (
  SELECT DISTINCT itype, user_id, n FROM (
    SELECT 'mobile_money_number'::text AS itype, wr.user_id, public.fraud_normalize_identifier('mobile_money_number', wr.mobile_money_number) AS n
    FROM public.withdrawal_requests wr
    JOIN public.profiles pr ON pr.id = wr.user_id
    WHERE pr.is_frozen = TRUE
      AND EXISTS (SELECT 1 FROM public.fraud_identity_blocks b WHERE b.source_user_id = pr.id AND b.status='active')
      AND NULLIF(btrim(wr.mobile_money_number), '') IS NOT NULL
    UNION
    SELECT 'phone'::text AS itype, wr.user_id, public.fraud_normalize_identifier('phone', wr.mobile_money_number) AS n
    FROM public.withdrawal_requests wr
    JOIN public.profiles pr ON pr.id = wr.user_id
    WHERE pr.is_frozen = TRUE
      AND EXISTS (SELECT 1 FROM public.fraud_identity_blocks b WHERE b.source_user_id = pr.id AND b.status='active')
      AND NULLIF(btrim(wr.mobile_money_number), '') IS NOT NULL
    UNION
    SELECT 'mobile_money_number'::text AS itype, spm.user_id, public.fraud_normalize_identifier('mobile_money_number', spm.momo_number) AS n
    FROM public.saved_payout_methods spm
    JOIN public.profiles pr ON pr.id = spm.user_id
    WHERE pr.is_frozen = TRUE
      AND EXISTS (SELECT 1 FROM public.fraud_identity_blocks b WHERE b.source_user_id = pr.id AND b.status='active')
      AND NULLIF(btrim(spm.momo_number), '') IS NOT NULL
    UNION
    SELECT 'phone'::text AS itype, spm.user_id, public.fraud_normalize_identifier('phone', spm.momo_number) AS n
    FROM public.saved_payout_methods spm
    JOIN public.profiles pr ON pr.id = spm.user_id
    WHERE pr.is_frozen = TRUE
      AND EXISTS (SELECT 1 FROM public.fraud_identity_blocks b WHERE b.source_user_id = pr.id AND b.status='active')
      AND NULLIF(btrim(spm.momo_number), '') IS NOT NULL
  ) u
  WHERE length(n) >= 9
) t
ON CONFLICT (identifier_type, normalized_value) DO UPDATE SET status='active', released_at=NULL, released_by=NULL;