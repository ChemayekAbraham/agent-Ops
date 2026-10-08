-- Awareness calls, LANDLORD calls only: a landlord is asked whether they consent to receive the rent through Welile and whether they
-- know about the payment code (OTP), instead of the merchant-code question. Tenant and agent calls behave exactly as before.
-- No pipeline status, approval, rejection, money or landlord payout OTP function is touched; rent_requests is only read.
--
--   rent_pipeline_awareness_calls  + landlord_consent ('consents' | 'unsure' | 'refuses') and aware_payout_otp ('knew' | 'heard' | 'did_not_know'),
--     both nullable. The answers CHECK is replaced: an answered tenant/agent call needs aware_30m, aware_merchant_codes, explained and has both new
--     columns NULL; an answered landlord call needs aware_30m, landlord_consent, aware_payout_otp, explained and has aware_merchant_codes NULL;
--     an unanswered call has every answer NULL. Landlord calls recorded before this migration (recorded_at before 2026-10-08 09:00:00+00) were asked the old three
--     questions and stay valid through an explicit legacy branch. The append-only trigger is untouched.
--   record_awareness_call          + p_landlord_consent, p_aware_payout_otp (appended last, DEFAULT NULL); the old signature is dropped, so a call
--     with the old ten named arguments still resolves (a tenant or agent call is unchanged; a landlord call from an old page is refused with a
--     message that says to refresh).
--   reports                        every report returns the new columns; summary, by_team, by_caller and my_awareness_calls_summary add consent
--     counts and payout-OTP counts; the merchant-code counts are taken over tenant and agent rows only. The existing answer filter
--     (p_answer_field / p_answer) also accepts landlord_consent and aware_payout_otp, so no filter signature changes. awareness_calls_scoped
--     returns two more columns, so it is dropped and recreated; the reports that call it keep their signatures.
-- Same role gates as before.

ALTER TABLE public.rent_pipeline_awareness_calls
  ADD COLUMN IF NOT EXISTS landlord_consent text
    CONSTRAINT rent_pipeline_awareness_calls_landlord_consent_check CHECK (landlord_consent IN ('consents', 'unsure', 'refuses')),
  ADD COLUMN IF NOT EXISTS aware_payout_otp text
    CONSTRAINT rent_pipeline_awareness_calls_aware_payout_otp_check CHECK (aware_payout_otp IN ('knew', 'heard', 'did_not_know'));

ALTER TABLE public.rent_pipeline_awareness_calls DROP CONSTRAINT IF EXISTS rent_pipeline_awareness_calls_answers_check;

ALTER TABLE public.rent_pipeline_awareness_calls
  ADD CONSTRAINT rent_pipeline_awareness_calls_answers_check CHECK (
    -- unanswered: no answers
    (call_result <> 'answered'
      AND aware_30m IS NULL AND aware_merchant_codes IS NULL AND explained IS NULL AND landlord_consent IS NULL AND aware_payout_otp IS NULL)
    -- answered tenant or agent: the three original questions only
    OR (call_result = 'answered' AND subject_type IN ('tenant', 'agent')
      AND aware_30m IS NOT NULL AND aware_merchant_codes IS NOT NULL AND explained IS NOT NULL AND landlord_consent IS NULL AND aware_payout_otp IS NULL)
    -- answered landlord: 30M, consent, payment code (OTP), explained; no merchant-code question
    OR (call_result = 'answered' AND subject_type = 'landlord'
      AND aware_30m IS NOT NULL AND landlord_consent IS NOT NULL AND aware_payout_otp IS NOT NULL AND explained IS NOT NULL AND aware_merchant_codes IS NULL)
    -- legacy: landlord calls recorded before this migration were asked the old three questions
    OR (call_result = 'answered' AND subject_type = 'landlord' AND recorded_at < '2026-10-08 09:00:00+00'::timestamptz
      AND aware_30m IS NOT NULL AND aware_merchant_codes IS NOT NULL AND explained IS NOT NULL AND landlord_consent IS NULL AND aware_payout_otp IS NULL)
  ) NOT VALID;

-- Validate only when every existing row passes; otherwise leave it NOT VALID (new rows are still checked) and say so.
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM public.rent_pipeline_awareness_calls c
  WHERE NOT (
    (c.call_result <> 'answered'
      AND c.aware_30m IS NULL AND c.aware_merchant_codes IS NULL AND c.explained IS NULL AND c.landlord_consent IS NULL AND c.aware_payout_otp IS NULL)
    OR (c.call_result = 'answered' AND c.subject_type IN ('tenant', 'agent')
      AND c.aware_30m IS NOT NULL AND c.aware_merchant_codes IS NOT NULL AND c.explained IS NOT NULL AND c.landlord_consent IS NULL AND c.aware_payout_otp IS NULL)
    OR (c.call_result = 'answered' AND c.subject_type = 'landlord'
      AND c.aware_30m IS NOT NULL AND c.landlord_consent IS NOT NULL AND c.aware_payout_otp IS NOT NULL AND c.explained IS NOT NULL AND c.aware_merchant_codes IS NULL)
    OR (c.call_result = 'answered' AND c.subject_type = 'landlord' AND c.recorded_at < '2026-10-08 09:00:00+00'::timestamptz
      AND c.aware_30m IS NOT NULL AND c.aware_merchant_codes IS NOT NULL AND c.explained IS NOT NULL AND c.landlord_consent IS NULL AND c.aware_payout_otp IS NULL)
  );
  IF v_bad = 0 THEN
    ALTER TABLE public.rent_pipeline_awareness_calls VALIDATE CONSTRAINT rent_pipeline_awareness_calls_answers_check;
  ELSE
    RAISE NOTICE 'rent_pipeline_awareness_calls_answers_check left NOT VALID: % existing rows do not match it', v_bad;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.record_awareness_call(uuid, text, text, timestamptz, text, uuid, text, text, text, text);
DROP FUNCTION IF EXISTS public.awareness_calls_scoped(timestamptz, timestamptz, text, uuid, text, text, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.record_awareness_call(
  p_rent_request_id uuid,
  p_subject_type text,
  p_subject_phone text,
  p_dial_started_at timestamptz,
  p_call_result text,
  p_subject_user_id uuid DEFAULT NULL,
  p_aware_30m text DEFAULT NULL,
  p_aware_merchant_codes text DEFAULT NULL,
  p_explained text DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_landlord_consent text DEFAULT NULL,
  p_aware_payout_otp text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_req record;
  v_staff boolean;
  v_is_sc boolean;
  v_team text;
  v_phone text := btrim(COALESCE(p_subject_phone, ''));
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_row public.rent_pipeline_awareness_calls%ROWTYPE;
  v_existing public.rent_pipeline_awareness_calls%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF p_rent_request_id IS NULL THEN RAISE EXCEPTION 'p_rent_request_id is required'; END IF;

  SELECT rr.id, rr.status, rr.tenant_id, rr.landlord_id, rr.agent_id, rr.service_center_manager_id
    INTO v_req
  FROM public.rent_requests rr
  WHERE rr.id = p_rent_request_id;
  IF v_req.id IS NULL THEN RAISE EXCEPTION 'Rent Plan not found'; END IF;

  v_staff := public.has_role(v_actor, 'tenant_ops') OR public.has_role(v_actor, 'landlord_ops') OR public.has_role(v_actor, 'agent_ops')
          OR public.has_role(v_actor, 'operations') OR public.has_role(v_actor, 'manager') OR public.has_role(v_actor, 'super_admin')
          OR public.has_role(v_actor, 'coo') OR public.has_role(v_actor, 'ceo') OR public.has_role(v_actor, 'cto')
          OR public.has_role(v_actor, 'cfo');
  v_is_sc := v_req.service_center_manager_id IS NOT NULL AND v_req.service_center_manager_id = v_actor;
  IF NOT (v_staff OR v_is_sc) THEN RAISE EXCEPTION 'not authorized'; END IF;

  v_team := CASE
    WHEN v_is_sc THEN 'service_centre'
    WHEN public.has_role(v_actor, 'agent_ops') THEN 'agent_ops'
    WHEN public.has_role(v_actor, 'tenant_ops') THEN 'tenant_ops'
    WHEN public.has_role(v_actor, 'landlord_ops') THEN 'landlord_ops'
    ELSE 'other'
  END;

  IF p_subject_type IS NULL OR p_subject_type NOT IN ('tenant', 'landlord', 'agent') THEN
    RAISE EXCEPTION 'invalid subject type: %, expected tenant/landlord/agent', p_subject_type;
  END IF;
  IF length(v_phone) < 7 THEN RAISE EXCEPTION 'the phone number that was called is required'; END IF;
  IF p_dial_started_at IS NULL THEN RAISE EXCEPTION 'p_dial_started_at is required'; END IF;
  IF p_dial_started_at > now() + interval '5 minutes' THEN RAISE EXCEPTION 'the call cannot start in the future'; END IF;
  IF p_dial_started_at < now() - interval '7 days' THEN RAISE EXCEPTION 'a call can be recorded up to 7 days after it was dialled'; END IF;

  IF p_call_result IS NULL OR p_call_result NOT IN ('answered', 'no_answer', 'phone_off', 'wrong_number') THEN
    RAISE EXCEPTION 'invalid call result: %, expected answered/no_answer/phone_off/wrong_number', p_call_result;
  END IF;
  IF p_call_result = 'answered' THEN
    IF p_subject_type = 'landlord' THEN
      -- A landlord is asked about the 30M access, whether they consent to receive the rent through Welile, whether they know
      -- about the payment code (OTP), and whether it was explained. The merchant codes are not asked of a landlord.
      IF p_aware_30m IS NULL OR p_landlord_consent IS NULL OR p_aware_payout_otp IS NULL OR p_explained IS NULL THEN
        RAISE EXCEPTION 'an answered landlord call needs all four answers: aware_30m, landlord_consent, aware_payout_otp and explained';
      END IF;
      IF p_aware_merchant_codes IS NOT NULL THEN
        RAISE EXCEPTION 'a landlord call does not ask about the merchant codes: record landlord_consent and aware_payout_otp instead (refresh the page if you see this)';
      END IF;
      IF p_aware_30m NOT IN ('knew', 'heard', 'did_not_know') OR p_aware_payout_otp NOT IN ('knew', 'heard', 'did_not_know') THEN
        RAISE EXCEPTION 'awareness answers must be knew, heard or did_not_know';
      END IF;
      IF p_landlord_consent NOT IN ('consents', 'unsure', 'refuses') THEN
        RAISE EXCEPTION 'landlord_consent must be consents, unsure or refuses';
      END IF;
      IF p_explained NOT IN ('yes', 'partly', 'no') THEN
        RAISE EXCEPTION 'explained must be yes, partly or no';
      END IF;
    ELSE
      IF p_aware_30m IS NULL OR p_aware_merchant_codes IS NULL OR p_explained IS NULL THEN
        RAISE EXCEPTION 'an answered call needs all three answers: aware_30m, aware_merchant_codes and explained';
      END IF;
      IF p_aware_30m NOT IN ('knew', 'heard', 'did_not_know') OR p_aware_merchant_codes NOT IN ('knew', 'heard', 'did_not_know') THEN
        RAISE EXCEPTION 'awareness answers must be knew, heard or did_not_know';
      END IF;
      IF p_explained NOT IN ('yes', 'partly', 'no') THEN
        RAISE EXCEPTION 'explained must be yes, partly or no';
      END IF;
      IF p_landlord_consent IS NOT NULL OR p_aware_payout_otp IS NOT NULL THEN
        RAISE EXCEPTION 'landlord consent and payment code answers can only be recorded for a landlord call';
      END IF;
    END IF;
  ELSIF p_aware_30m IS NOT NULL OR p_aware_merchant_codes IS NOT NULL OR p_explained IS NOT NULL
        OR p_landlord_consent IS NOT NULL OR p_aware_payout_otp IS NOT NULL THEN
    RAISE EXCEPTION 'answers can only be recorded for an answered call';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 2000 THEN RAISE EXCEPTION 'note must be 2000 characters or fewer'; END IF;

  -- If the person is named, they must be the one on this Rent Plan (the plan's agent or its service centre manager for 'agent').
  IF p_subject_user_id IS NOT NULL AND NOT COALESCE(
    (p_subject_type = 'tenant' AND p_subject_user_id = v_req.tenant_id)
    OR (p_subject_type = 'landlord' AND p_subject_user_id = v_req.landlord_id)
    OR (p_subject_type = 'agent' AND (p_subject_user_id = v_req.agent_id OR p_subject_user_id = v_req.service_center_manager_id)),
    false
  ) THEN
    RAISE EXCEPTION 'that person is not the % on this Rent Plan', p_subject_type;
  END IF;

  -- A repeat of the same call (double tap, retry) returns the row already stored.
  SELECT * INTO v_existing
  FROM public.rent_pipeline_awareness_calls c
  WHERE c.caller_id = v_actor AND c.rent_request_id = p_rent_request_id
    AND c.subject_phone = v_phone AND c.dial_started_at = p_dial_started_at;
  IF v_existing.id IS NOT NULL THEN
    RETURN to_jsonb(v_existing) || jsonb_build_object('already_recorded', true);
  END IF;

  INSERT INTO public.rent_pipeline_awareness_calls (
    rent_request_id, subject_type, subject_user_id, subject_phone, caller_id, caller_team, pipeline_stage,
    dial_started_at, call_result, aware_30m, aware_merchant_codes, explained, note, landlord_consent, aware_payout_otp
  ) VALUES (
    p_rent_request_id, p_subject_type, p_subject_user_id, v_phone, v_actor, v_team, v_req.status,
    p_dial_started_at, p_call_result, p_aware_30m, p_aware_merchant_codes, p_explained, v_note, p_landlord_consent, p_aware_payout_otp
  )
  RETURNING * INTO v_row;

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    'rent_pipeline.awareness_call_recorded',
    v_actor,
    'rent_request',
    p_rent_request_id,
    jsonb_build_object(
      'awareness_call_id', v_row.id,
      'subject_type', p_subject_type,
      'call_result', p_call_result,
      'caller_team', v_team,
      'pipeline_stage', v_req.status,
      'aware_30m', p_aware_30m,
      'aware_merchant_codes', p_aware_merchant_codes,
      'landlord_consent', p_landlord_consent,
      'aware_payout_otp', p_aware_payout_otp,
      'explained', p_explained,
      'source', 'awareness_calls'
    )
  );

  RETURN to_jsonb(v_row) || jsonb_build_object('already_recorded', false);
END;
$function$;

REVOKE ALL ON FUNCTION public.record_awareness_call(uuid, text, text, timestamptz, text, uuid, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_awareness_call(uuid, text, text, timestamptz, text, uuid, text, text, text, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.awareness_calls_scoped(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_team text DEFAULT NULL,
  p_caller uuid DEFAULT NULL,
  p_subject_type text DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_result text DEFAULT NULL,
  p_answer_field text DEFAULT NULL,
  p_answer text DEFAULT NULL,
  p_status text DEFAULT NULL
)
RETURNS TABLE(
  ac_id uuid, ac_rr uuid, ac_subject_type text, ac_subject_user uuid, ac_phone text, ac_caller uuid, ac_team text,
  ac_stage text, ac_dial timestamptz, ac_recorded timestamptz, ac_result text, ac_30m text, ac_codes text,
  ac_explained text, ac_note text, ac_day date, ac_person text, ac_consent text, ac_otp text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_d2 date;
  v_d1 date;
  v_start timestamptz;
  v_end timestamptz;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'tenant_ops') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'super_admin')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  IF p_team IS NOT NULL AND p_team NOT IN ('service_centre', 'agent_ops', 'tenant_ops', 'landlord_ops', 'other') THEN
    RAISE EXCEPTION 'invalid team: %, expected service_centre/agent_ops/tenant_ops/landlord_ops/other', p_team;
  END IF;
  IF p_subject_type IS NOT NULL AND p_subject_type NOT IN ('tenant', 'landlord', 'agent') THEN
    RAISE EXCEPTION 'invalid subject type: %, expected tenant/landlord/agent', p_subject_type;
  END IF;
  IF p_result IS NOT NULL AND p_result NOT IN ('answered', 'no_answer', 'phone_off', 'wrong_number') THEN
    RAISE EXCEPTION 'invalid call result: %, expected answered/no_answer/phone_off/wrong_number', p_result;
  END IF;
  IF (p_answer_field IS NULL) <> (p_answer IS NULL) THEN
    RAISE EXCEPTION 'p_answer_field and p_answer go together';
  END IF;
  IF p_answer_field IS NOT NULL THEN
    IF p_answer_field NOT IN ('aware_30m', 'aware_merchant_codes', 'explained', 'landlord_consent', 'aware_payout_otp') THEN
      RAISE EXCEPTION 'invalid answer field: %, expected aware_30m/aware_merchant_codes/explained/landlord_consent/aware_payout_otp', p_answer_field;
    END IF;
    IF p_answer_field = 'explained' AND p_answer NOT IN ('yes', 'partly', 'no') THEN
      RAISE EXCEPTION 'explained must be yes, partly or no';
    END IF;
    IF p_answer_field = 'landlord_consent' AND p_answer NOT IN ('consents', 'unsure', 'refuses') THEN
      RAISE EXCEPTION 'landlord_consent must be consents, unsure or refuses';
    END IF;
    IF p_answer_field IN ('aware_30m', 'aware_merchant_codes', 'aware_payout_otp') AND p_answer NOT IN ('knew', 'heard', 'did_not_know') THEN
      RAISE EXCEPTION 'awareness answers must be knew, heard or did_not_know';
    END IF;
  END IF;

  v_d2 := COALESCE((p_to AT TIME ZONE 'Africa/Kampala')::date, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_d1 := COALESCE((p_from AT TIME ZONE 'Africa/Kampala')::date, v_d2 - 29);
  IF v_d1 > v_d2 THEN RAISE EXCEPTION 'p_from is after p_to'; END IF;
  IF v_d2 - v_d1 > 365 THEN RAISE EXCEPTION 'the window can be at most 366 days'; END IF;
  v_start := (v_d1::timestamp AT TIME ZONE 'Africa/Kampala');
  v_end := ((v_d2 + 1)::timestamp AT TIME ZONE 'Africa/Kampala');

  RETURN QUERY
  SELECT c.id, c.rent_request_id, c.subject_type, c.subject_user_id, c.subject_phone, c.caller_id, c.caller_team,
         c.pipeline_stage, c.dial_started_at, c.recorded_at, c.call_result, c.aware_30m, c.aware_merchant_codes,
         c.explained, c.note,
         (c.dial_started_at AT TIME ZONE 'Africa/Kampala')::date,
         COALESCE(c.subject_user_id::text,
                  'p:' || CASE WHEN regexp_replace(c.subject_phone, '\D', '', 'g') ~ '^256'
                               THEN '0' || substr(regexp_replace(c.subject_phone, '\D', '', 'g'), 4)
                               ELSE regexp_replace(c.subject_phone, '\D', '', 'g') END),
         c.landlord_consent, c.aware_payout_otp
  FROM public.rent_pipeline_awareness_calls c
  WHERE c.dial_started_at >= v_start AND c.dial_started_at < v_end
    AND (p_team IS NULL OR c.caller_team = p_team)
    AND (p_caller IS NULL OR c.caller_id = p_caller)
    AND (p_subject_type IS NULL OR c.subject_type = p_subject_type)
    AND (p_result IS NULL OR c.call_result = p_result)
    AND (p_answer IS NULL OR (CASE p_answer_field
                                WHEN 'aware_30m' THEN c.aware_30m
                                WHEN 'aware_merchant_codes' THEN c.aware_merchant_codes
                                WHEN 'explained' THEN c.explained
                                WHEN 'landlord_consent' THEN c.landlord_consent
                                WHEN 'aware_payout_otp' THEN c.aware_payout_otp
                              END) = p_answer)
    -- the merchant-code question is not asked of a landlord (older landlord calls kept their old answer, which is not counted)
    AND (p_answer_field IS DISTINCT FROM 'aware_merchant_codes' OR c.subject_type <> 'landlord')
    AND (p_status IS NULL OR c.rent_request_id IN (
          SELECT rr0.id FROM public.rent_requests rr0 WHERE rr0.status = p_status))
    AND ((p_region IS NULL AND p_district IS NULL) OR c.rent_request_id IN (
          SELECT rr.id FROM public.rent_requests rr
          JOIN public.v_tlb_tenant_base tb ON tb.tenant_id = rr.tenant_id
          WHERE (p_region IS NULL OR tb.region = p_region)
            AND (p_district IS NULL OR tb.district_name = p_district)));
END;
$function$;

REVOKE ALL ON FUNCTION public.awareness_calls_scoped(timestamptz, timestamptz, text, uuid, text, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.awareness_calls_scoped(timestamptz, timestamptz, text, uuid, text, text, text, text, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.awareness_calls_summary(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_team text DEFAULT NULL,
  p_caller uuid DEFAULT NULL,
  p_subject_type text DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_result text DEFAULT NULL,
  p_answer_field text DEFAULT NULL,
  p_answer text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_bucket text DEFAULT 'day'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_d2 date;
  v_d1 date;
  v_bucket text := COALESCE(p_bucket, 'day');
  v_result jsonb;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'tenant_ops') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'super_admin')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  IF v_bucket NOT IN ('day', 'week') THEN RAISE EXCEPTION 'invalid bucket: %, expected day/week', p_bucket; END IF;

  v_d2 := COALESCE((p_to AT TIME ZONE 'Africa/Kampala')::date, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_d1 := COALESCE((p_from AT TIME ZONE 'Africa/Kampala')::date, v_d2 - 29);

  WITH s AS MATERIALIZED (
    SELECT * FROM public.awareness_calls_scoped(p_from, p_to, p_team, p_caller, p_subject_type, p_region, p_district, p_result, p_answer_field, p_answer, p_status)
  ),
  tot AS (
    SELECT count(*)::int AS calls,
           count(*) FILTER (WHERE x.ac_result = 'answered')::int AS answered,
           count(*) FILTER (WHERE x.ac_result = 'answered' AND x.ac_subject_type <> 'landlord')::int AS answered_ta,
           count(*) FILTER (WHERE x.ac_result = 'answered' AND x.ac_subject_type = 'landlord' AND x.ac_consent IS NOT NULL)::int AS answered_ll,
           count(*) FILTER (WHERE x.ac_result = 'answered' AND x.ac_subject_type = 'landlord' AND x.ac_consent IS NULL)::int AS answered_ll_old,
           count(*) FILTER (WHERE x.ac_consent = 'consents')::int AS consent_consents,
           count(*) FILTER (WHERE x.ac_consent = 'unsure')::int AS consent_unsure,
           count(*) FILTER (WHERE x.ac_consent = 'refuses')::int AS consent_refuses,
           count(*) FILTER (WHERE x.ac_otp = 'knew')::int AS otp_knew,
           count(*) FILTER (WHERE x.ac_otp = 'heard')::int AS otp_heard,
           count(*) FILTER (WHERE x.ac_otp = 'did_not_know')::int AS otp_did_not_know,
           count(*) FILTER (WHERE x.ac_result = 'no_answer')::int AS no_answer,
           count(*) FILTER (WHERE x.ac_result = 'phone_off')::int AS phone_off,
           count(*) FILTER (WHERE x.ac_result = 'wrong_number')::int AS wrong_number,
           count(DISTINCT x.ac_person)::int AS people_called,
           count(DISTINCT x.ac_person) FILTER (WHERE x.ac_result = 'answered')::int AS people_reached,
           count(DISTINCT x.ac_rr)::int AS rent_plans,
           count(DISTINCT x.ac_caller)::int AS callers,
           count(*) FILTER (WHERE x.ac_30m = 'knew')::int AS m30_knew,
           count(*) FILTER (WHERE x.ac_30m = 'heard')::int AS m30_heard,
           count(*) FILTER (WHERE x.ac_30m = 'did_not_know')::int AS m30_did_not_know,
           count(*) FILTER (WHERE x.ac_codes = 'knew' AND x.ac_subject_type <> 'landlord')::int AS codes_knew,
           count(*) FILTER (WHERE x.ac_codes = 'heard' AND x.ac_subject_type <> 'landlord')::int AS codes_heard,
           count(*) FILTER (WHERE x.ac_codes = 'did_not_know' AND x.ac_subject_type <> 'landlord')::int AS codes_did_not_know,
           count(*) FILTER (WHERE x.ac_explained = 'yes')::int AS expl_yes,
           count(*) FILTER (WHERE x.ac_explained = 'partly')::int AS expl_partly,
           count(*) FILTER (WHERE x.ac_explained = 'no')::int AS expl_no
    FROM s x
  ),
  per_day AS (
    SELECT (CASE WHEN v_bucket = 'week' THEN GREATEST(date_trunc('week', x.ac_day::timestamp)::date, v_d1) ELSE x.ac_day END) AS d, count(*)::int AS calls,
           count(*) FILTER (WHERE x.ac_result = 'answered')::int AS answered,
           count(DISTINCT x.ac_person)::int AS people_called,
           count(DISTINCT x.ac_person) FILTER (WHERE x.ac_result = 'answered')::int AS people_reached
    FROM s x GROUP BY 1
  ),
  -- day buckets: one per Kampala day. Week buckets: Monday to Sunday, the first and last clipped to the window.
  days AS (
    SELECT (CASE WHEN v_bucket = 'week' THEN GREATEST(gs::date, v_d1) ELSE gs::date END) AS d,
           (CASE WHEN v_bucket = 'week' THEN LEAST(gs::date + 6, v_d2) ELSE gs::date END) AS d_end
    FROM generate_series(
           (CASE WHEN v_bucket = 'week' THEN date_trunc('week', v_d1::timestamp) ELSE v_d1::timestamp END),
           v_d2::timestamp,
           (CASE WHEN v_bucket = 'week' THEN interval '7 days' ELSE interval '1 day' END)) gs
  )
  SELECT jsonb_build_object(
    'window', jsonb_build_object('start_day', v_d1, 'end_day', v_d2, 'days', (v_d2 - v_d1) + 1, 'timezone', 'Africa/Kampala'),
    'bucket', v_bucket,
    'filters', jsonb_build_object('team', p_team, 'caller', p_caller, 'subject_type', p_subject_type, 'region', p_region,
      'district', p_district, 'result', p_result, 'answer_field', p_answer_field, 'answer', p_answer, 'status', p_status),
    'basis', 'Calls are counted on the Kampala day they were dialled. People are counted once however often they were phoned. The 30M and explained counts are per answered call. The merchant-code counts are over answered tenant and agent calls only; landlords are asked about consent and the payment code (OTP) instead, and are counted over answered landlord calls that were asked those questions.',
    'totals', (SELECT jsonb_build_object(
        'calls', t.calls, 'answered', t.answered, 'no_answer', t.no_answer, 'phone_off', t.phone_off, 'wrong_number', t.wrong_number,
        'answered_pct', round(t.answered::numeric / NULLIF(t.calls, 0) * 100, 1),
        'people_called', t.people_called, 'people_reached', t.people_reached,
        'rent_plans_called', t.rent_plans, 'callers', t.callers,
        'answered_tenant_agent', t.answered_ta, 'answered_landlord', t.answered_ll, 'answered_landlord_old_questions', t.answered_ll_old) FROM tot t),
    'aware_30m', (SELECT jsonb_build_object(
        'knew', t.m30_knew, 'heard', t.m30_heard, 'did_not_know', t.m30_did_not_know,
        'knew_pct', round(t.m30_knew::numeric / NULLIF(t.answered, 0) * 100, 1),
        'heard_pct', round(t.m30_heard::numeric / NULLIF(t.answered, 0) * 100, 1),
        'did_not_know_pct', round(t.m30_did_not_know::numeric / NULLIF(t.answered, 0) * 100, 1)) FROM tot t),
    'aware_merchant_codes', (SELECT jsonb_build_object(
        'knew', t.codes_knew, 'heard', t.codes_heard, 'did_not_know', t.codes_did_not_know,
        'knew_pct', round(t.codes_knew::numeric / NULLIF(t.answered_ta, 0) * 100, 1),
        'heard_pct', round(t.codes_heard::numeric / NULLIF(t.answered_ta, 0) * 100, 1),
        'did_not_know_pct', round(t.codes_did_not_know::numeric / NULLIF(t.answered_ta, 0) * 100, 1)) FROM tot t),
    'landlord_consent', (SELECT jsonb_build_object(
        'consents', t.consent_consents, 'unsure', t.consent_unsure, 'refuses', t.consent_refuses,
        'consents_pct', round(t.consent_consents::numeric / NULLIF(t.answered_ll, 0) * 100, 1),
        'unsure_pct', round(t.consent_unsure::numeric / NULLIF(t.answered_ll, 0) * 100, 1),
        'refuses_pct', round(t.consent_refuses::numeric / NULLIF(t.answered_ll, 0) * 100, 1)) FROM tot t),
    'aware_payout_otp', (SELECT jsonb_build_object(
        'knew', t.otp_knew, 'heard', t.otp_heard, 'did_not_know', t.otp_did_not_know,
        'knew_pct', round(t.otp_knew::numeric / NULLIF(t.answered_ll, 0) * 100, 1),
        'heard_pct', round(t.otp_heard::numeric / NULLIF(t.answered_ll, 0) * 100, 1),
        'did_not_know_pct', round(t.otp_did_not_know::numeric / NULLIF(t.answered_ll, 0) * 100, 1)) FROM tot t),
    'explained', (SELECT jsonb_build_object(
        'yes', t.expl_yes, 'partly', t.expl_partly, 'no', t.expl_no,
        'yes_pct', round(t.expl_yes::numeric / NULLIF(t.answered, 0) * 100, 1),
        'partly_pct', round(t.expl_partly::numeric / NULLIF(t.answered, 0) * 100, 1),
        'no_pct', round(t.expl_no::numeric / NULLIF(t.answered, 0) * 100, 1)) FROM tot t),
    'trend', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'day', k.d, 'period_end', k.d_end, 'calls', COALESCE(p.calls, 0), 'answered', COALESCE(p.answered, 0),
        'people_called', COALESCE(p.people_called, 0), 'people_reached', COALESCE(p.people_reached, 0),
        'answered_pct', round(COALESCE(p.answered, 0)::numeric / NULLIF(COALESCE(p.calls, 0), 0) * 100, 1)) ORDER BY k.d)
        FROM days k LEFT JOIN per_day p ON p.d = k.d), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.awareness_calls_summary(timestamptz, timestamptz, text, uuid, text, text, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.awareness_calls_summary(timestamptz, timestamptz, text, uuid, text, text, text, text, text, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.awareness_calls_by_team(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_team text DEFAULT NULL,
  p_caller uuid DEFAULT NULL,
  p_subject_type text DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_result text DEFAULT NULL,
  p_answer_field text DEFAULT NULL,
  p_answer text DEFAULT NULL,
  p_status text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_d2 date;
  v_d1 date;
  v_result jsonb;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'tenant_ops') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'super_admin')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  v_d2 := COALESCE((p_to AT TIME ZONE 'Africa/Kampala')::date, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_d1 := COALESCE((p_from AT TIME ZONE 'Africa/Kampala')::date, v_d2 - 29);

  WITH s AS MATERIALIZED (
    SELECT * FROM public.awareness_calls_scoped(p_from, p_to, p_team, p_caller, p_subject_type, p_region, p_district, p_result, p_answer_field, p_answer, p_status)
  ),
  teams(team, ord) AS (VALUES ('service_centre', 1), ('agent_ops', 2), ('tenant_ops', 3), ('landlord_ops', 4), ('other', 5)),
  agg AS (
    SELECT x.ac_team AS team,
           count(*)::int AS calls,
           count(*) FILTER (WHERE x.ac_result = 'answered')::int AS answered,
           count(DISTINCT x.ac_person)::int AS people_called,
           count(DISTINCT x.ac_person) FILTER (WHERE x.ac_result = 'answered')::int AS people_reached,
           count(DISTINCT x.ac_rr)::int AS rent_plans,
           count(DISTINCT x.ac_caller)::int AS callers,
           count(*) FILTER (WHERE x.ac_30m = 'knew')::int AS m30_knew,
           count(*) FILTER (WHERE x.ac_30m = 'heard')::int AS m30_heard,
           count(*) FILTER (WHERE x.ac_30m = 'did_not_know')::int AS m30_did_not_know,
           count(*) FILTER (WHERE x.ac_codes = 'knew' AND x.ac_subject_type <> 'landlord')::int AS codes_knew,
           count(*) FILTER (WHERE x.ac_codes = 'heard' AND x.ac_subject_type <> 'landlord')::int AS codes_heard,
           count(*) FILTER (WHERE x.ac_codes = 'did_not_know' AND x.ac_subject_type <> 'landlord')::int AS codes_did_not_know,
           count(*) FILTER (WHERE x.ac_consent = 'consents')::int AS consent_consents,
           count(*) FILTER (WHERE x.ac_consent = 'unsure')::int AS consent_unsure,
           count(*) FILTER (WHERE x.ac_consent = 'refuses')::int AS consent_refuses,
           count(*) FILTER (WHERE x.ac_otp = 'knew')::int AS otp_knew,
           count(*) FILTER (WHERE x.ac_otp = 'heard')::int AS otp_heard,
           count(*) FILTER (WHERE x.ac_otp = 'did_not_know')::int AS otp_did_not_know,
           count(*) FILTER (WHERE x.ac_explained = 'yes')::int AS expl_yes,
           count(*) FILTER (WHERE x.ac_explained = 'partly')::int AS expl_partly,
           count(*) FILTER (WHERE x.ac_explained = 'no')::int AS expl_no
    FROM s x GROUP BY x.ac_team
  )
  SELECT jsonb_build_object(
    'window', jsonb_build_object('start_day', v_d1, 'end_day', v_d2, 'days', (v_d2 - v_d1) + 1, 'timezone', 'Africa/Kampala'),
    'filters', jsonb_build_object('team', p_team, 'caller', p_caller, 'subject_type', p_subject_type, 'region', p_region,
      'district', p_district, 'result', p_result, 'answer_field', p_answer_field, 'answer', p_answer, 'status', p_status),
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'team', t.team, 'calls', COALESCE(a.calls, 0), 'answered', COALESCE(a.answered, 0),
        'answered_pct', round(COALESCE(a.answered, 0)::numeric / NULLIF(COALESCE(a.calls, 0), 0) * 100, 1),
        'people_called', COALESCE(a.people_called, 0), 'people_reached', COALESCE(a.people_reached, 0),
        'rent_plans_called', COALESCE(a.rent_plans, 0), 'callers', COALESCE(a.callers, 0),
        'aware_30m', jsonb_build_object('knew', COALESCE(a.m30_knew, 0), 'heard', COALESCE(a.m30_heard, 0), 'did_not_know', COALESCE(a.m30_did_not_know, 0)),
        'aware_merchant_codes', jsonb_build_object('knew', COALESCE(a.codes_knew, 0), 'heard', COALESCE(a.codes_heard, 0), 'did_not_know', COALESCE(a.codes_did_not_know, 0)),
        'landlord_consent', jsonb_build_object('consents', COALESCE(a.consent_consents, 0), 'unsure', COALESCE(a.consent_unsure, 0), 'refuses', COALESCE(a.consent_refuses, 0)),
        'aware_payout_otp', jsonb_build_object('knew', COALESCE(a.otp_knew, 0), 'heard', COALESCE(a.otp_heard, 0), 'did_not_know', COALESCE(a.otp_did_not_know, 0)),
        'explained', jsonb_build_object('yes', COALESCE(a.expl_yes, 0), 'partly', COALESCE(a.expl_partly, 0), 'no', COALESCE(a.expl_no, 0))
      ) ORDER BY t.ord) FROM teams t LEFT JOIN agg a ON a.team = t.team), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.awareness_calls_by_team(timestamptz, timestamptz, text, uuid, text, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.awareness_calls_by_team(timestamptz, timestamptz, text, uuid, text, text, text, text, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.awareness_calls_by_caller(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_team text DEFAULT NULL,
  p_caller uuid DEFAULT NULL,
  p_subject_type text DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_limit integer DEFAULT 200,
  p_district text DEFAULT NULL,
  p_result text DEFAULT NULL,
  p_answer_field text DEFAULT NULL,
  p_answer text DEFAULT NULL,
  p_status text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_d2 date;
  v_d1 date;
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
  v_result jsonb;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'tenant_ops') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'super_admin')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  v_d2 := COALESCE((p_to AT TIME ZONE 'Africa/Kampala')::date, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_d1 := COALESCE((p_from AT TIME ZONE 'Africa/Kampala')::date, v_d2 - 29);

  WITH s AS MATERIALIZED (
    SELECT * FROM public.awareness_calls_scoped(p_from, p_to, p_team, p_caller, p_subject_type, p_region, p_district, p_result, p_answer_field, p_answer, p_status)
  ),
  agg AS (
    SELECT x.ac_caller AS caller,
           (array_agg(x.ac_team ORDER BY x.ac_dial DESC))[1] AS team,
           count(*)::int AS calls,
           count(*) FILTER (WHERE x.ac_result = 'answered')::int AS answered,
           count(DISTINCT x.ac_person)::int AS people_called,
           count(DISTINCT x.ac_person) FILTER (WHERE x.ac_result = 'answered')::int AS people_reached,
           count(DISTINCT x.ac_rr)::int AS rent_plans,
           count(*) FILTER (WHERE x.ac_30m = 'knew')::int AS m30_knew,
           count(*) FILTER (WHERE x.ac_30m = 'heard')::int AS m30_heard,
           count(*) FILTER (WHERE x.ac_30m = 'did_not_know')::int AS m30_did_not_know,
           count(*) FILTER (WHERE x.ac_codes = 'knew' AND x.ac_subject_type <> 'landlord')::int AS codes_knew,
           count(*) FILTER (WHERE x.ac_codes = 'heard' AND x.ac_subject_type <> 'landlord')::int AS codes_heard,
           count(*) FILTER (WHERE x.ac_codes = 'did_not_know' AND x.ac_subject_type <> 'landlord')::int AS codes_did_not_know,
           count(*) FILTER (WHERE x.ac_consent = 'consents')::int AS consent_consents,
           count(*) FILTER (WHERE x.ac_consent = 'unsure')::int AS consent_unsure,
           count(*) FILTER (WHERE x.ac_consent = 'refuses')::int AS consent_refuses,
           count(*) FILTER (WHERE x.ac_otp = 'knew')::int AS otp_knew,
           count(*) FILTER (WHERE x.ac_otp = 'heard')::int AS otp_heard,
           count(*) FILTER (WHERE x.ac_otp = 'did_not_know')::int AS otp_did_not_know,
           count(*) FILTER (WHERE x.ac_explained = 'yes')::int AS expl_yes,
           count(*) FILTER (WHERE x.ac_explained = 'partly')::int AS expl_partly,
           count(*) FILTER (WHERE x.ac_explained = 'no')::int AS expl_no,
           MAX(x.ac_dial) AS last_call_at
    FROM s x GROUP BY x.ac_caller
  ),
  ranked AS (
    SELECT a.*, COALESCE(NULLIF(btrim(pr.full_name), ''), 'Unnamed caller') AS caller_name
    FROM agg a LEFT JOIN public.profiles pr ON pr.id = a.caller
    ORDER BY a.calls DESC, a.last_call_at DESC, a.caller
    LIMIT v_limit
  )
  SELECT jsonb_build_object(
    'window', jsonb_build_object('start_day', v_d1, 'end_day', v_d2, 'days', (v_d2 - v_d1) + 1, 'timezone', 'Africa/Kampala'),
    'filters', jsonb_build_object('team', p_team, 'caller', p_caller, 'subject_type', p_subject_type, 'region', p_region,
      'district', p_district, 'result', p_result, 'answer_field', p_answer_field, 'answer', p_answer, 'status', p_status),
    'total_callers', (SELECT count(*) FROM agg),
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'caller_id', r.caller, 'caller_name', r.caller_name, 'team', r.team,
        'calls', r.calls, 'answered', r.answered,
        'answered_pct', round(r.answered::numeric / NULLIF(r.calls, 0) * 100, 1),
        'people_called', r.people_called, 'people_reached', r.people_reached, 'rent_plans_called', r.rent_plans,
        'aware_30m', jsonb_build_object('knew', r.m30_knew, 'heard', r.m30_heard, 'did_not_know', r.m30_did_not_know),
        'aware_merchant_codes', jsonb_build_object('knew', r.codes_knew, 'heard', r.codes_heard, 'did_not_know', r.codes_did_not_know),
        'landlord_consent', jsonb_build_object('consents', r.consent_consents, 'unsure', r.consent_unsure, 'refuses', r.consent_refuses),
        'aware_payout_otp', jsonb_build_object('knew', r.otp_knew, 'heard', r.otp_heard, 'did_not_know', r.otp_did_not_know),
        'explained', jsonb_build_object('yes', r.expl_yes, 'partly', r.expl_partly, 'no', r.expl_no),
        'last_call_at', r.last_call_at
      ) ORDER BY r.calls DESC, r.last_call_at DESC, r.caller) FROM ranked r), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.awareness_calls_by_caller(timestamptz, timestamptz, text, uuid, text, text, integer, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.awareness_calls_by_caller(timestamptz, timestamptz, text, uuid, text, text, integer, text, text, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.awareness_calls_log(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_team text DEFAULT NULL,
  p_caller uuid DEFAULT NULL,
  p_subject_type text DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_district text DEFAULT NULL,
  p_result text DEFAULT NULL,
  p_answer_field text DEFAULT NULL,
  p_answer text DEFAULT NULL,
  p_status text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_d2 date;
  v_d1 date;
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_result jsonb;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'tenant_ops') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'super_admin')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  v_d2 := COALESCE((p_to AT TIME ZONE 'Africa/Kampala')::date, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_d1 := COALESCE((p_from AT TIME ZONE 'Africa/Kampala')::date, v_d2 - 29);

  WITH s AS MATERIALIZED (
    SELECT x.*, row_number() OVER (ORDER BY x.ac_dial DESC, x.ac_id) AS rn
    FROM public.awareness_calls_scoped(p_from, p_to, p_team, p_caller, p_subject_type, p_region, p_district, p_result, p_answer_field, p_answer, p_status) x
  ),
  page AS (
    SELECT s.*, rr.status AS cur_status, rr.tenant_id, rr.landlord_id, rr.agent_id,
           cp.full_name AS caller_name,
           CASE s.ac_subject_type
             WHEN 'tenant' THEN tp.full_name
             WHEN 'landlord' THEN lp.name
             ELSE COALESCE(sp.full_name, ap.full_name)
           END AS subject_name,
           tb.region AS region
    FROM s
    JOIN public.rent_requests rr ON rr.id = s.ac_rr
    LEFT JOIN public.profiles cp ON cp.id = s.ac_caller
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    LEFT JOIN public.landlords lp ON lp.id = rr.landlord_id
    LEFT JOIN public.profiles sp ON sp.id = s.ac_subject_user
    LEFT JOIN public.profiles ap ON ap.id = rr.agent_id
    LEFT JOIN public.v_tlb_tenant_base tb ON tb.tenant_id = rr.tenant_id
    WHERE s.rn > v_offset AND s.rn <= v_offset + v_limit
  )
  SELECT jsonb_build_object(
    'window', jsonb_build_object('start_day', v_d1, 'end_day', v_d2, 'days', (v_d2 - v_d1) + 1, 'timezone', 'Africa/Kampala'),
    'filters', jsonb_build_object('team', p_team, 'caller', p_caller, 'subject_type', p_subject_type, 'region', p_region,
      'district', p_district, 'result', p_result, 'answer_field', p_answer_field, 'answer', p_answer, 'status', p_status),
    'total', (SELECT count(*) FROM s),
    'limit', v_limit,
    'offset', v_offset,
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', p.ac_id, 'rent_request_id', p.ac_rr, 'plan_code', left(p.ac_rr::text, 8),
        'subject_type', p.ac_subject_type, 'subject_name', COALESCE(p.subject_name, 'Unnamed'), 'subject_phone', p.ac_phone,
        'caller_id', p.ac_caller, 'caller_name', COALESCE(NULLIF(btrim(p.caller_name), ''), 'Unnamed caller'), 'caller_team', p.ac_team,
        'pipeline_stage', p.ac_stage, 'current_status', p.cur_status, 'region', p.region,
        'call_result', p.ac_result, 'aware_30m', p.ac_30m, 'aware_merchant_codes', p.ac_codes,
        'landlord_consent', p.ac_consent, 'aware_payout_otp', p.ac_otp, 'explained', p.ac_explained,
        'note', p.ac_note, 'day', p.ac_day, 'dial_started_at', p.ac_dial, 'recorded_at', p.ac_recorded
      ) ORDER BY p.rn) FROM page p), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.awareness_calls_log(timestamptz, timestamptz, text, uuid, text, text, integer, integer, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.awareness_calls_log(timestamptz, timestamptz, text, uuid, text, text, integer, integer, text, text, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.my_awareness_calls_summary(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_staff boolean;
  v_d2 date;
  v_d1 date;
  v_start timestamptz;
  v_end timestamptz;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authorized'; END IF;
  v_staff := public.has_role(v_actor, 'tenant_ops') OR public.has_role(v_actor, 'landlord_ops') OR public.has_role(v_actor, 'agent_ops')
          OR public.has_role(v_actor, 'operations') OR public.has_role(v_actor, 'manager') OR public.has_role(v_actor, 'super_admin')
          OR public.has_role(v_actor, 'coo') OR public.has_role(v_actor, 'ceo') OR public.has_role(v_actor, 'cto')
          OR public.has_role(v_actor, 'cfo');
  IF NOT (v_staff OR EXISTS (SELECT 1 FROM public.rent_requests x WHERE x.service_center_manager_id = v_actor)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  v_d2 := COALESCE((p_to AT TIME ZONE 'Africa/Kampala')::date, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_d1 := COALESCE((p_from AT TIME ZONE 'Africa/Kampala')::date, v_d2 - 29);
  IF v_d1 > v_d2 THEN RAISE EXCEPTION 'p_from is after p_to'; END IF;
  IF v_d2 - v_d1 > 365 THEN RAISE EXCEPTION 'the window can be at most 366 days'; END IF;
  v_start := (v_d1::timestamp AT TIME ZONE 'Africa/Kampala');
  v_end := ((v_d2 + 1)::timestamp AT TIME ZONE 'Africa/Kampala');

  WITH s AS MATERIALIZED (
    SELECT c.*,
           COALESCE(c.subject_user_id::text,
                    'p:' || CASE WHEN regexp_replace(c.subject_phone, '\D', '', 'g') ~ '^256'
                                 THEN '0' || substr(regexp_replace(c.subject_phone, '\D', '', 'g'), 4)
                                 ELSE regexp_replace(c.subject_phone, '\D', '', 'g') END) AS person
    FROM public.rent_pipeline_awareness_calls c
    WHERE c.caller_id = v_actor AND c.dial_started_at >= v_start AND c.dial_started_at < v_end
  ),
  tot AS (
    SELECT count(*)::int AS calls,
           count(*) FILTER (WHERE x.call_result = 'answered')::int AS answered,
           count(*) FILTER (WHERE x.call_result = 'answered' AND x.subject_type <> 'landlord')::int AS answered_ta,
           count(*) FILTER (WHERE x.call_result = 'answered' AND x.subject_type = 'landlord' AND x.landlord_consent IS NOT NULL)::int AS answered_ll,
           count(*) FILTER (WHERE x.landlord_consent = 'consents')::int AS consent_consents,
           count(*) FILTER (WHERE x.landlord_consent = 'unsure')::int AS consent_unsure,
           count(*) FILTER (WHERE x.landlord_consent = 'refuses')::int AS consent_refuses,
           count(*) FILTER (WHERE x.aware_payout_otp = 'knew')::int AS otp_knew,
           count(*) FILTER (WHERE x.aware_payout_otp = 'heard')::int AS otp_heard,
           count(*) FILTER (WHERE x.aware_payout_otp = 'did_not_know')::int AS otp_did_not_know,
           count(*) FILTER (WHERE x.call_result = 'no_answer')::int AS no_answer,
           count(*) FILTER (WHERE x.call_result = 'phone_off')::int AS phone_off,
           count(*) FILTER (WHERE x.call_result = 'wrong_number')::int AS wrong_number,
           count(DISTINCT x.person)::int AS people_called,
           count(DISTINCT x.person) FILTER (WHERE x.call_result = 'answered')::int AS people_reached,
           count(DISTINCT x.rent_request_id)::int AS rent_plans,
           count(*) FILTER (WHERE x.aware_30m = 'knew')::int AS m30_knew,
           count(*) FILTER (WHERE x.aware_30m = 'heard')::int AS m30_heard,
           count(*) FILTER (WHERE x.aware_30m = 'did_not_know')::int AS m30_did_not_know,
           count(*) FILTER (WHERE x.aware_merchant_codes = 'knew' AND x.subject_type <> 'landlord')::int AS codes_knew,
           count(*) FILTER (WHERE x.aware_merchant_codes = 'heard' AND x.subject_type <> 'landlord')::int AS codes_heard,
           count(*) FILTER (WHERE x.aware_merchant_codes = 'did_not_know' AND x.subject_type <> 'landlord')::int AS codes_did_not_know,
           count(*) FILTER (WHERE x.explained = 'yes')::int AS expl_yes,
           count(*) FILTER (WHERE x.explained = 'partly')::int AS expl_partly,
           count(*) FILTER (WHERE x.explained = 'no')::int AS expl_no
    FROM s x
  )
  SELECT jsonb_build_object(
    'window', jsonb_build_object('start_day', v_d1, 'end_day', v_d2, 'days', (v_d2 - v_d1) + 1, 'timezone', 'Africa/Kampala'),
    'basis', 'Only your own calls, counted on the Kampala day they were dialled. People are counted once however often they were phoned. The 30M and explained counts are per answered call. The merchant-code counts are over your answered tenant and agent calls only; landlords are asked about consent and the payment code (OTP) instead.',
    'totals', (SELECT jsonb_build_object(
        'calls', t.calls, 'answered', t.answered, 'no_answer', t.no_answer, 'phone_off', t.phone_off, 'wrong_number', t.wrong_number,
        'answered_pct', round(t.answered::numeric / NULLIF(t.calls, 0) * 100, 1),
        'people_called', t.people_called, 'people_reached', t.people_reached, 'rent_plans_called', t.rent_plans,
        'answered_tenant_agent', t.answered_ta, 'answered_landlord', t.answered_ll) FROM tot t),
    'aware_30m', (SELECT jsonb_build_object(
        'knew', t.m30_knew, 'heard', t.m30_heard, 'did_not_know', t.m30_did_not_know,
        'knew_pct', round(t.m30_knew::numeric / NULLIF(t.answered, 0) * 100, 1),
        'heard_pct', round(t.m30_heard::numeric / NULLIF(t.answered, 0) * 100, 1),
        'did_not_know_pct', round(t.m30_did_not_know::numeric / NULLIF(t.answered, 0) * 100, 1)) FROM tot t),
    'aware_merchant_codes', (SELECT jsonb_build_object(
        'knew', t.codes_knew, 'heard', t.codes_heard, 'did_not_know', t.codes_did_not_know,
        'knew_pct', round(t.codes_knew::numeric / NULLIF(t.answered_ta, 0) * 100, 1),
        'heard_pct', round(t.codes_heard::numeric / NULLIF(t.answered_ta, 0) * 100, 1),
        'did_not_know_pct', round(t.codes_did_not_know::numeric / NULLIF(t.answered_ta, 0) * 100, 1)) FROM tot t),
    'landlord_consent', (SELECT jsonb_build_object(
        'consents', t.consent_consents, 'unsure', t.consent_unsure, 'refuses', t.consent_refuses,
        'consents_pct', round(t.consent_consents::numeric / NULLIF(t.answered_ll, 0) * 100, 1),
        'unsure_pct', round(t.consent_unsure::numeric / NULLIF(t.answered_ll, 0) * 100, 1),
        'refuses_pct', round(t.consent_refuses::numeric / NULLIF(t.answered_ll, 0) * 100, 1)) FROM tot t),
    'aware_payout_otp', (SELECT jsonb_build_object(
        'knew', t.otp_knew, 'heard', t.otp_heard, 'did_not_know', t.otp_did_not_know,
        'knew_pct', round(t.otp_knew::numeric / NULLIF(t.answered_ll, 0) * 100, 1),
        'heard_pct', round(t.otp_heard::numeric / NULLIF(t.answered_ll, 0) * 100, 1),
        'did_not_know_pct', round(t.otp_did_not_know::numeric / NULLIF(t.answered_ll, 0) * 100, 1)) FROM tot t),
    'explained', (SELECT jsonb_build_object(
        'yes', t.expl_yes, 'partly', t.expl_partly, 'no', t.expl_no,
        'yes_pct', round(t.expl_yes::numeric / NULLIF(t.answered, 0) * 100, 1),
        'partly_pct', round(t.expl_partly::numeric / NULLIF(t.answered, 0) * 100, 1),
        'no_pct', round(t.expl_no::numeric / NULLIF(t.answered, 0) * 100, 1)) FROM tot t)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.my_awareness_calls_summary(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_awareness_calls_summary(timestamptz, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION public.my_awareness_calls_log(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_staff boolean;
  v_d2 date;
  v_d1 date;
  v_start timestamptz;
  v_end timestamptz;
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authorized'; END IF;
  v_staff := public.has_role(v_actor, 'tenant_ops') OR public.has_role(v_actor, 'landlord_ops') OR public.has_role(v_actor, 'agent_ops')
          OR public.has_role(v_actor, 'operations') OR public.has_role(v_actor, 'manager') OR public.has_role(v_actor, 'super_admin')
          OR public.has_role(v_actor, 'coo') OR public.has_role(v_actor, 'ceo') OR public.has_role(v_actor, 'cto')
          OR public.has_role(v_actor, 'cfo');
  IF NOT (v_staff OR EXISTS (SELECT 1 FROM public.rent_requests x WHERE x.service_center_manager_id = v_actor)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  v_d2 := COALESCE((p_to AT TIME ZONE 'Africa/Kampala')::date, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_d1 := COALESCE((p_from AT TIME ZONE 'Africa/Kampala')::date, v_d2 - 29);
  IF v_d1 > v_d2 THEN RAISE EXCEPTION 'p_from is after p_to'; END IF;
  IF v_d2 - v_d1 > 365 THEN RAISE EXCEPTION 'the window can be at most 366 days'; END IF;
  v_start := (v_d1::timestamp AT TIME ZONE 'Africa/Kampala');
  v_end := ((v_d2 + 1)::timestamp AT TIME ZONE 'Africa/Kampala');

  WITH s AS MATERIALIZED (
    SELECT c.*, row_number() OVER (ORDER BY c.dial_started_at DESC, c.id) AS rn
    FROM public.rent_pipeline_awareness_calls c
    WHERE c.caller_id = v_actor AND c.dial_started_at >= v_start AND c.dial_started_at < v_end
  ),
  page AS (
    SELECT s.*, rr.status AS cur_status,
           CASE s.subject_type
             WHEN 'tenant' THEN tp.full_name
             WHEN 'landlord' THEN lp.name
             ELSE COALESCE(sp.full_name, ap.full_name)
           END AS subject_name
    FROM s
    JOIN public.rent_requests rr ON rr.id = s.rent_request_id
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    LEFT JOIN public.landlords lp ON lp.id = rr.landlord_id
    LEFT JOIN public.profiles sp ON sp.id = s.subject_user_id
    LEFT JOIN public.profiles ap ON ap.id = rr.agent_id
    WHERE s.rn > v_offset AND s.rn <= v_offset + v_limit
  )
  SELECT jsonb_build_object(
    'window', jsonb_build_object('start_day', v_d1, 'end_day', v_d2, 'days', (v_d2 - v_d1) + 1, 'timezone', 'Africa/Kampala'),
    'total', (SELECT count(*) FROM s),
    'limit', v_limit,
    'offset', v_offset,
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', p.id, 'rent_request_id', p.rent_request_id, 'plan_code', left(p.rent_request_id::text, 8),
        'subject_type', p.subject_type, 'subject_name', COALESCE(p.subject_name, 'Unnamed'), 'subject_phone', p.subject_phone,
        'pipeline_stage', p.pipeline_stage, 'current_status', p.cur_status,
        'call_result', p.call_result, 'aware_30m', p.aware_30m, 'aware_merchant_codes', p.aware_merchant_codes,
        'landlord_consent', p.landlord_consent, 'aware_payout_otp', p.aware_payout_otp, 'explained', p.explained,
        'note', p.note, 'day', (p.dial_started_at AT TIME ZONE 'Africa/Kampala')::date,
        'dial_started_at', p.dial_started_at, 'recorded_at', p.recorded_at
      ) ORDER BY p.rn) FROM page p), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.my_awareness_calls_log(timestamptz, timestamptz, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_awareness_calls_log(timestamptz, timestamptz, integer, integer) TO authenticated;
