-- Awareness call monitoring page: four more filters on the Prompt 4 reports, and one options function. Read-only; nothing is written.
--
-- The monitoring page filters by call result, answer choice, district and request status as well as the existing team, caller, person
-- type and region. The reports only took the last four, and filtering a paginated log in the browser would give wrong totals, so the
-- same functions now take the extra filters, applied on the server. Every new parameter is optional and added at the END of the list,
-- so a call that does not pass them behaves exactly as before.
--
--   p_district      the Rent Plan's tenant's district (v_tlb_tenant_base), with or without p_region
--   p_result        answered | no_answer | phone_off | wrong_number
--   p_answer_field  aware_30m | aware_merchant_codes | explained   (given together with p_answer)
--   p_answer        knew | heard | did_not_know   (for the first two fields)   yes | partly | no   (for explained)
--   p_status        the Rent Plan's status now (rent_requests.status)
--   awareness_coverage_gaps takes p_district and p_status only (a gap has no call to filter by result or answer).
--
-- awareness_calls_options() lists what the filter bar offers: callers who have recorded a call, regions and districts, request statuses.
-- Same role gate as the other reports: an enabled tenant_ops, coo, ceo or super_admin role. The old signatures are dropped first so a
-- call can never be ambiguous between two versions.

DROP FUNCTION IF EXISTS public.awareness_calls_log(timestamptz, timestamptz, text, uuid, text, text, integer, integer);
DROP FUNCTION IF EXISTS public.awareness_coverage_gaps(timestamptz, timestamptz, text, text, integer, integer);
DROP FUNCTION IF EXISTS public.awareness_calls_by_caller(timestamptz, timestamptz, text, uuid, text, text, integer);
DROP FUNCTION IF EXISTS public.awareness_calls_by_team(timestamptz, timestamptz, text, uuid, text, text);
DROP FUNCTION IF EXISTS public.awareness_calls_summary(timestamptz, timestamptz, text, uuid, text, text);
DROP FUNCTION IF EXISTS public.awareness_calls_scoped(timestamptz, timestamptz, text, uuid, text, text);

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
  ac_explained text, ac_note text, ac_day date, ac_person text
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
    IF p_answer_field NOT IN ('aware_30m', 'aware_merchant_codes', 'explained') THEN
      RAISE EXCEPTION 'invalid answer field: %, expected aware_30m/aware_merchant_codes/explained', p_answer_field;
    END IF;
    IF p_answer_field = 'explained' AND p_answer NOT IN ('yes', 'partly', 'no') THEN
      RAISE EXCEPTION 'explained must be yes, partly or no';
    END IF;
    IF p_answer_field <> 'explained' AND p_answer NOT IN ('knew', 'heard', 'did_not_know') THEN
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
                               ELSE regexp_replace(c.subject_phone, '\D', '', 'g') END)
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
                              END) = p_answer)
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
  tot AS (
    SELECT count(*)::int AS calls,
           count(*) FILTER (WHERE x.ac_result = 'answered')::int AS answered,
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
           count(*) FILTER (WHERE x.ac_codes = 'knew')::int AS codes_knew,
           count(*) FILTER (WHERE x.ac_codes = 'heard')::int AS codes_heard,
           count(*) FILTER (WHERE x.ac_codes = 'did_not_know')::int AS codes_did_not_know,
           count(*) FILTER (WHERE x.ac_explained = 'yes')::int AS expl_yes,
           count(*) FILTER (WHERE x.ac_explained = 'partly')::int AS expl_partly,
           count(*) FILTER (WHERE x.ac_explained = 'no')::int AS expl_no
    FROM s x
  ),
  per_day AS (
    SELECT x.ac_day AS d, count(*)::int AS calls,
           count(*) FILTER (WHERE x.ac_result = 'answered')::int AS answered,
           count(DISTINCT x.ac_person)::int AS people_called,
           count(DISTINCT x.ac_person) FILTER (WHERE x.ac_result = 'answered')::int AS people_reached
    FROM s x GROUP BY x.ac_day
  ),
  days AS (SELECT gs::date AS d FROM generate_series(v_d1::timestamp, v_d2::timestamp, interval '1 day') gs)
  SELECT jsonb_build_object(
    'window', jsonb_build_object('start_day', v_d1, 'end_day', v_d2, 'days', (v_d2 - v_d1) + 1, 'timezone', 'Africa/Kampala'),
    'filters', jsonb_build_object('team', p_team, 'caller', p_caller, 'subject_type', p_subject_type, 'region', p_region,
      'district', p_district, 'result', p_result, 'answer_field', p_answer_field, 'answer', p_answer, 'status', p_status),
    'basis', 'Calls are counted on the Kampala day they were dialled. People are counted once however often they were phoned. The 30M, merchant-code and explained counts are per answered call.',
    'totals', (SELECT jsonb_build_object(
        'calls', t.calls, 'answered', t.answered, 'no_answer', t.no_answer, 'phone_off', t.phone_off, 'wrong_number', t.wrong_number,
        'answered_pct', round(t.answered::numeric / NULLIF(t.calls, 0) * 100, 1),
        'people_called', t.people_called, 'people_reached', t.people_reached,
        'rent_plans_called', t.rent_plans, 'callers', t.callers) FROM tot t),
    'aware_30m', (SELECT jsonb_build_object(
        'knew', t.m30_knew, 'heard', t.m30_heard, 'did_not_know', t.m30_did_not_know,
        'knew_pct', round(t.m30_knew::numeric / NULLIF(t.answered, 0) * 100, 1),
        'heard_pct', round(t.m30_heard::numeric / NULLIF(t.answered, 0) * 100, 1),
        'did_not_know_pct', round(t.m30_did_not_know::numeric / NULLIF(t.answered, 0) * 100, 1)) FROM tot t),
    'aware_merchant_codes', (SELECT jsonb_build_object(
        'knew', t.codes_knew, 'heard', t.codes_heard, 'did_not_know', t.codes_did_not_know,
        'knew_pct', round(t.codes_knew::numeric / NULLIF(t.answered, 0) * 100, 1),
        'heard_pct', round(t.codes_heard::numeric / NULLIF(t.answered, 0) * 100, 1),
        'did_not_know_pct', round(t.codes_did_not_know::numeric / NULLIF(t.answered, 0) * 100, 1)) FROM tot t),
    'explained', (SELECT jsonb_build_object(
        'yes', t.expl_yes, 'partly', t.expl_partly, 'no', t.expl_no,
        'yes_pct', round(t.expl_yes::numeric / NULLIF(t.answered, 0) * 100, 1),
        'partly_pct', round(t.expl_partly::numeric / NULLIF(t.answered, 0) * 100, 1),
        'no_pct', round(t.expl_no::numeric / NULLIF(t.answered, 0) * 100, 1)) FROM tot t),
    'trend', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'day', k.d, 'calls', COALESCE(p.calls, 0), 'answered', COALESCE(p.answered, 0),
        'people_called', COALESCE(p.people_called, 0), 'people_reached', COALESCE(p.people_reached, 0),
        'answered_pct', round(COALESCE(p.answered, 0)::numeric / NULLIF(COALESCE(p.calls, 0), 0) * 100, 1)) ORDER BY k.d)
        FROM days k LEFT JOIN per_day p ON p.d = k.d), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.awareness_calls_summary(timestamptz, timestamptz, text, uuid, text, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.awareness_calls_summary(timestamptz, timestamptz, text, uuid, text, text, text, text, text, text, text) TO authenticated;

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
           count(*) FILTER (WHERE x.ac_codes = 'knew')::int AS codes_knew,
           count(*) FILTER (WHERE x.ac_codes = 'heard')::int AS codes_heard,
           count(*) FILTER (WHERE x.ac_codes = 'did_not_know')::int AS codes_did_not_know,
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
           count(*) FILTER (WHERE x.ac_codes = 'knew')::int AS codes_knew,
           count(*) FILTER (WHERE x.ac_codes = 'heard')::int AS codes_heard,
           count(*) FILTER (WHERE x.ac_codes = 'did_not_know')::int AS codes_did_not_know,
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
        'explained', jsonb_build_object('yes', r.expl_yes, 'partly', r.expl_partly, 'no', r.expl_no),
        'last_call_at', r.last_call_at
      ) ORDER BY r.calls DESC, r.last_call_at DESC, r.caller) FROM ranked r), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.awareness_calls_by_caller(timestamptz, timestamptz, text, uuid, text, text, integer, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.awareness_calls_by_caller(timestamptz, timestamptz, text, uuid, text, text, integer, text, text, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.awareness_coverage_gaps(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_team text DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_district text DEFAULT NULL,
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
  v_start timestamptz;
  v_end timestamptz;
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_result jsonb;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'tenant_ops') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'super_admin')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  IF p_team IS NOT NULL AND p_team NOT IN ('service_centre', 'agent_ops', 'tenant_ops', 'landlord_ops', 'other') THEN
    RAISE EXCEPTION 'invalid team: %, expected service_centre/agent_ops/tenant_ops/landlord_ops/other', p_team;
  END IF;

  v_d2 := COALESCE((p_to AT TIME ZONE 'Africa/Kampala')::date, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_d1 := COALESCE((p_from AT TIME ZONE 'Africa/Kampala')::date, v_d2 - 29);
  IF v_d1 > v_d2 THEN RAISE EXCEPTION 'p_from is after p_to'; END IF;
  IF v_d2 - v_d1 > 365 THEN RAISE EXCEPTION 'the window can be at most 366 days'; END IF;
  v_start := (v_d1::timestamp AT TIME ZONE 'Africa/Kampala');
  v_end := ((v_d2 + 1)::timestamp AT TIME ZONE 'Africa/Kampala');

  WITH stg(stage, team, ord, label) AS (
    VALUES ('service_center_review', 'service_centre', 1, 'Service centre review'),
           ('pending', 'agent_ops', 2, 'Agent Ops review'),
           ('agent_ops_approved', 'tenant_ops', 3, 'Tenant Ops review'),
           ('tenant_ops_approved', 'landlord_ops', 4, 'Landlord Ops review'),
           ('landlord_ops_approved', 'other', 5, 'Partner Ops'),
           ('partner_ops_approved', 'other', 6, 'COO approval'),
           ('coo_approved', 'other', 7, 'CFO payout')
  ),
  passed AS MATERIALIZED (
    SELECT rr.id AS rr_id, s.stage, s.team, s.ord, s.label,
           CASE s.stage
             WHEN 'service_center_review' THEN rr.service_center_reviewed_at
             WHEN 'pending' THEN rr.agent_ops_reviewed_at
             WHEN 'agent_ops_approved' THEN rr.tenant_ops_reviewed_at
             WHEN 'tenant_ops_approved' THEN rr.landlord_ops_reviewed_at
             WHEN 'landlord_ops_approved' THEN rr.partner_ops_reviewed_at
             WHEN 'partner_ops_approved' THEN rr.coo_reviewed_at
             WHEN 'coo_approved' THEN rr.cfo_reviewed_at
           END AS passed_at,
           CASE s.stage
             WHEN 'service_center_review' THEN rr.service_center_reviewed_by
             WHEN 'pending' THEN rr.agent_ops_reviewed_by
             WHEN 'agent_ops_approved' THEN rr.tenant_ops_reviewed_by
             WHEN 'tenant_ops_approved' THEN rr.landlord_ops_reviewed_by
             WHEN 'landlord_ops_approved' THEN rr.partner_ops_reviewed_by
             WHEN 'partner_ops_approved' THEN rr.coo_reviewed_by
             WHEN 'coo_approved' THEN rr.cfo_reviewed_by
           END AS passed_by
    FROM public.rent_requests rr
    CROSS JOIN stg s
    WHERE (p_team IS NULL OR s.team = p_team)
  ),
  inwin AS MATERIALIZED (
    SELECT p.* FROM passed p
    WHERE p.passed_at >= v_start AND p.passed_at < v_end
      AND (p_status IS NULL OR p.rr_id IN (SELECT rr3.id FROM public.rent_requests rr3 WHERE rr3.status = p_status))
      AND ((p_region IS NULL AND p_district IS NULL) OR p.rr_id IN (
            SELECT rr2.id FROM public.rent_requests rr2
            JOIN public.v_tlb_tenant_base tb ON tb.tenant_id = rr2.tenant_id
            WHERE (p_region IS NULL OR tb.region = p_region)
              AND (p_district IS NULL OR tb.district_name = p_district)))
  ),
  marked AS MATERIALIZED (
    SELECT i.*,
           EXISTS (SELECT 1 FROM public.rent_pipeline_awareness_calls c
                   WHERE c.rent_request_id = i.rr_id AND c.pipeline_stage = i.stage) AS has_call
    FROM inwin i
  ),
  by_stage AS (
    SELECT s.stage, s.team, s.ord, s.label,
           count(m.rr_id)::int AS passed,
           count(m.rr_id) FILTER (WHERE m.has_call)::int AS with_call,
           count(m.rr_id) FILTER (WHERE NOT m.has_call)::int AS without_call
    FROM stg s LEFT JOIN marked m ON m.stage = s.stage
    WHERE p_team IS NULL OR s.team = p_team
    GROUP BY s.stage, s.team, s.ord, s.label
  ),
  gaps AS (
    SELECT m.*, row_number() OVER (ORDER BY m.passed_at DESC, m.rr_id, m.ord) AS rn
    FROM marked m WHERE NOT m.has_call
  ),
  page AS (
    SELECT g.*, rr.status AS cur_status, rr.tenant_id, rr.landlord_id, rr.agent_id,
           tp.full_name AS tenant_name, tp.phone AS tenant_phone,
           lp.name AS landlord_name, lp.phone AS landlord_phone,
           ap.full_name AS agent_name, rv.full_name AS passed_by_name,
           (SELECT count(*)::int FROM public.rent_pipeline_awareness_calls c WHERE c.rent_request_id = g.rr_id) AS calls_elsewhere
    FROM gaps g
    JOIN public.rent_requests rr ON rr.id = g.rr_id
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    LEFT JOIN public.landlords lp ON lp.id = rr.landlord_id
    LEFT JOIN public.profiles ap ON ap.id = rr.agent_id
    LEFT JOIN public.profiles rv ON rv.id = g.passed_by
    WHERE g.rn > v_offset AND g.rn <= v_offset + v_limit
  )
  SELECT jsonb_build_object(
    'window', jsonb_build_object('start_day', v_d1, 'end_day', v_d2, 'days', (v_d2 - v_d1) + 1, 'timezone', 'Africa/Kampala'),
    'filters', jsonb_build_object('team', p_team, 'region', p_region, 'district', p_district, 'status', p_status),
    'tracking_started', (SELECT (MIN(c.recorded_at) AT TIME ZONE 'Africa/Kampala')::date FROM public.rent_pipeline_awareness_calls c),
    'basis', 'A Rent Plan moved past a stage on the day that stage''s reviewed-at time falls in the window. It is a gap when no awareness call was recorded on that Rent Plan at that stage, by anyone, at any time. Rejections count as moving past.',
    'totals', jsonb_build_object(
      'passed', COALESCE((SELECT SUM(b.passed) FROM by_stage b), 0),
      'with_call', COALESCE((SELECT SUM(b.with_call) FROM by_stage b), 0),
      'without_call', COALESCE((SELECT SUM(b.without_call) FROM by_stage b), 0),
      'covered_pct', round(COALESCE((SELECT SUM(b.with_call) FROM by_stage b), 0)::numeric / NULLIF((SELECT SUM(b.passed) FROM by_stage b), 0) * 100, 1)),
    'by_stage', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'stage', b.stage, 'label', b.label, 'team', b.team, 'passed', b.passed, 'with_call', b.with_call, 'without_call', b.without_call,
        'covered_pct', round(b.with_call::numeric / NULLIF(b.passed, 0) * 100, 1)) ORDER BY b.ord) FROM by_stage b), '[]'::jsonb),
    'total', (SELECT count(*) FROM gaps),
    'limit', v_limit,
    'offset', v_offset,
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'rent_request_id', p.rr_id, 'plan_code', left(p.rr_id::text, 8),
        'stage', p.stage, 'stage_label', p.label, 'team', p.team,
        'passed_at', p.passed_at, 'passed_day', (p.passed_at AT TIME ZONE 'Africa/Kampala')::date,
        'passed_by', p.passed_by, 'passed_by_name', p.passed_by_name,
        'current_status', p.cur_status,
        'tenant_id', p.tenant_id, 'tenant_name', p.tenant_name, 'tenant_phone', p.tenant_phone,
        'landlord_name', p.landlord_name, 'landlord_phone', p.landlord_phone,
        'agent_id', p.agent_id, 'agent_name', p.agent_name,
        'calls_at_other_stages', p.calls_elsewhere
      ) ORDER BY p.rn) FROM page p), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.awareness_coverage_gaps(timestamptz, timestamptz, text, text, integer, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.awareness_coverage_gaps(timestamptz, timestamptz, text, text, integer, integer, text, text) TO authenticated;

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
        'call_result', p.ac_result, 'aware_30m', p.ac_30m, 'aware_merchant_codes', p.ac_codes, 'explained', p.ac_explained,
        'note', p.ac_note, 'day', p.ac_day, 'dial_started_at', p.ac_dial, 'recorded_at', p.ac_recorded
      ) ORDER BY p.rn) FROM page p), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.awareness_calls_log(timestamptz, timestamptz, text, uuid, text, text, integer, integer, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.awareness_calls_log(timestamptz, timestamptz, text, uuid, text, text, integer, integer, text, text, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.awareness_calls_options()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'tenant_ops') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'super_admin')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  WITH callers AS (
    SELECT c.caller_id, (array_agg(c.caller_team ORDER BY c.dial_started_at DESC))[1] AS team, count(*) AS calls
    FROM public.rent_pipeline_awareness_calls c GROUP BY c.caller_id
  ),
  loc AS (
    SELECT DISTINCT tb.region, tb.district_name
    FROM public.rent_requests rr
    JOIN public.v_tlb_tenant_base tb ON tb.tenant_id = rr.tenant_id
    WHERE tb.region IS NOT NULL
  )
  SELECT jsonb_build_object(
    'callers', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', k.caller_id, 'name', COALESCE(NULLIF(btrim(pr.full_name), ''), 'Unnamed caller'), 'team', k.team, 'calls', k.calls)
        ORDER BY COALESCE(NULLIF(btrim(pr.full_name), ''), 'zzz'))
        FROM callers k LEFT JOIN public.profiles pr ON pr.id = k.caller_id), '[]'::jsonb),
    'regions', COALESCE((SELECT jsonb_agg(DISTINCT l.region ORDER BY l.region) FROM loc l), '[]'::jsonb),
    'districts', COALESCE((SELECT jsonb_agg(jsonb_build_object('region', l.region, 'district', l.district_name) ORDER BY l.region, l.district_name)
                           FROM loc l WHERE l.district_name IS NOT NULL), '[]'::jsonb),
    'statuses', COALESCE((SELECT jsonb_agg(DISTINCT rr.status ORDER BY rr.status) FROM public.rent_requests rr WHERE rr.status IS NOT NULL), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.awareness_calls_options() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.awareness_calls_options() TO authenticated;
