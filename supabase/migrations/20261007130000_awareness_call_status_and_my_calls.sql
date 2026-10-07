-- Awareness calls: a batched "has this Rent Plan been called?" status for the queue lists, and "my own calls" reports for the
-- signed-in caller. Additive and read-only: three new functions, nothing written, no existing object, status, trigger, policy or
-- approve / reject function touched, nothing blocked or confirmed.
--
--   awareness_call_status_for_requests(p_request_ids uuid[])   one row per Rent Plan (max 200 ids): calls_total, calls_at_current_stage,
--                                                              answered_at_current_stage, last_call_at, answered_person_types
--   my_awareness_calls_summary(p_from, p_to)                   the signed-in caller's own calls only: totals and the three answers
--   my_awareness_calls_log(p_from, p_to, p_limit, p_offset)    the same calls, newest first
--
-- Who may call them: the same people who may record a call (record_awareness_call): an enabled tenant_ops, landlord_ops, agent_ops,
-- operations, manager, super_admin, coo, ceo, cto or cfo role, or a Rent Plan's own service centre manager. For the status report a
-- service centre manager only gets the Rent Plans routed to them; staff get every Rent Plan asked for. The "my" reports are limited
-- to auth.uid() whoever calls them. "At the current stage" = the call's pipeline_stage equals the Rent Plan's status now.
-- Kampala (Africa/Kampala) calendar days, as in the monitoring reports. No anon grant.

CREATE OR REPLACE FUNCTION public.awareness_call_status_for_requests(p_request_ids uuid[])
RETURNS TABLE(
  rent_request_id uuid,
  calls_total integer,
  calls_at_current_stage integer,
  answered_at_current_stage integer,
  last_call_at timestamptz,
  answered_person_types text[]
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_staff boolean;
  v_ids uuid[];
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authorized'; END IF;

  v_staff := public.has_role(v_actor, 'tenant_ops') OR public.has_role(v_actor, 'landlord_ops') OR public.has_role(v_actor, 'agent_ops')
          OR public.has_role(v_actor, 'operations') OR public.has_role(v_actor, 'manager') OR public.has_role(v_actor, 'super_admin')
          OR public.has_role(v_actor, 'coo') OR public.has_role(v_actor, 'ceo') OR public.has_role(v_actor, 'cto')
          OR public.has_role(v_actor, 'cfo');
  IF NOT (v_staff OR EXISTS (SELECT 1 FROM public.rent_requests x WHERE x.service_center_manager_id = v_actor)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  IF p_request_ids IS NULL OR cardinality(p_request_ids) = 0 THEN RETURN; END IF;
  IF cardinality(p_request_ids) > 200 THEN RAISE EXCEPTION 'at most 200 Rent Plans per call'; END IF;
  SELECT array_agg(DISTINCT u) INTO v_ids FROM unnest(p_request_ids) u WHERE u IS NOT NULL;

  RETURN QUERY
  SELECT rr.id,
         count(c.id)::int,
         (count(c.id) FILTER (WHERE c.pipeline_stage = rr.status))::int,
         (count(c.id) FILTER (WHERE c.pipeline_stage = rr.status AND c.call_result = 'answered'))::int,
         max(c.dial_started_at),
         COALESCE(array_agg(DISTINCT c.subject_type ORDER BY c.subject_type) FILTER (WHERE c.call_result = 'answered'), ARRAY[]::text[])
  FROM public.rent_requests rr
  LEFT JOIN public.rent_pipeline_awareness_calls c ON c.rent_request_id = rr.id
  WHERE rr.id = ANY (v_ids)
    AND (v_staff OR rr.service_center_manager_id = v_actor)
  GROUP BY rr.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.awareness_call_status_for_requests(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.awareness_call_status_for_requests(uuid[]) TO authenticated;

-- ─── my_awareness_calls_summary ─────────────────────────────────────────────────

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
           count(*) FILTER (WHERE x.call_result = 'no_answer')::int AS no_answer,
           count(*) FILTER (WHERE x.call_result = 'phone_off')::int AS phone_off,
           count(*) FILTER (WHERE x.call_result = 'wrong_number')::int AS wrong_number,
           count(DISTINCT x.person)::int AS people_called,
           count(DISTINCT x.person) FILTER (WHERE x.call_result = 'answered')::int AS people_reached,
           count(DISTINCT x.rent_request_id)::int AS rent_plans,
           count(*) FILTER (WHERE x.aware_30m = 'knew')::int AS m30_knew,
           count(*) FILTER (WHERE x.aware_30m = 'heard')::int AS m30_heard,
           count(*) FILTER (WHERE x.aware_30m = 'did_not_know')::int AS m30_did_not_know,
           count(*) FILTER (WHERE x.aware_merchant_codes = 'knew')::int AS codes_knew,
           count(*) FILTER (WHERE x.aware_merchant_codes = 'heard')::int AS codes_heard,
           count(*) FILTER (WHERE x.aware_merchant_codes = 'did_not_know')::int AS codes_did_not_know,
           count(*) FILTER (WHERE x.explained = 'yes')::int AS expl_yes,
           count(*) FILTER (WHERE x.explained = 'partly')::int AS expl_partly,
           count(*) FILTER (WHERE x.explained = 'no')::int AS expl_no
    FROM s x
  )
  SELECT jsonb_build_object(
    'window', jsonb_build_object('start_day', v_d1, 'end_day', v_d2, 'days', (v_d2 - v_d1) + 1, 'timezone', 'Africa/Kampala'),
    'basis', 'Only your own calls, counted on the Kampala day they were dialled. People are counted once however often they were phoned. The 30M, merchant-code and explained counts are per answered call.',
    'totals', (SELECT jsonb_build_object(
        'calls', t.calls, 'answered', t.answered, 'no_answer', t.no_answer, 'phone_off', t.phone_off, 'wrong_number', t.wrong_number,
        'answered_pct', round(t.answered::numeric / NULLIF(t.calls, 0) * 100, 1),
        'people_called', t.people_called, 'people_reached', t.people_reached, 'rent_plans_called', t.rent_plans) FROM tot t),
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
        'no_pct', round(t.expl_no::numeric / NULLIF(t.answered, 0) * 100, 1)) FROM tot t)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.my_awareness_calls_summary(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_awareness_calls_summary(timestamptz, timestamptz) TO authenticated;

-- ─── my_awareness_calls_log ─────────────────────────────────────────────────────

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
        'call_result', p.call_result, 'aware_30m', p.aware_30m, 'aware_merchant_codes', p.aware_merchant_codes, 'explained', p.explained,
        'note', p.note, 'day', (p.dial_started_at AT TIME ZONE 'Africa/Kampala')::date,
        'dial_started_at', p.dial_started_at, 'recorded_at', p.recorded_at
      ) ORDER BY p.rn) FROM page p), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.my_awareness_calls_log(timestamptz, timestamptz, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_awareness_calls_log(timestamptz, timestamptz, integer, integer) TO authenticated;
