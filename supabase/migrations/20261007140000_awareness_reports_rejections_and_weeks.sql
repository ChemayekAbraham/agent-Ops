-- Awareness call reports: rejected Rent Plans count as moving past a stage, legacy 'agent_verified' calls count at Tenant Ops, and the trend
-- can be grouped by week. Reporting only: nothing is written, no pipeline status, approval, rejection, function or trigger is touched,
-- and rent_requests and rent_pipeline_awareness_calls are only read.
--
--   awareness_coverage_gaps   + p_outcome ('approved' | 'rejected', last parameter) and an "outcome" on every row.
--     A Rent Plan also moved past a stage when it was REJECTED there, even when that stage's *_reviewed_at is empty (the move is dated by
--     rent_requests.rejected_at). rejected_at_stage holds the status the plan was at when it was rejected; the legacy names read as their
--     stages: 'agent_verified' = Tenant Ops (agent_ops_approved), 'coo' = COO approval (partner_ops_approved). A rejection with no stage
--     counts at the Service centre when service_center_reviewed_at is set. The outcome is 'rejected' when the plan was rejected at that stage
--     (and its status is still rejected, or the stage has no reviewed-at time), otherwise 'approved'. Totals and by_stage also carry "rejected".
--     A call stored with pipeline_stage 'agent_verified' counts as a call at the Tenant Ops stage.
--   awareness_calls_summary   + p_bucket ('day' | 'week', last parameter, default 'day') for the trend. Weeks run Monday to Sunday on Kampala
--     days, the first and last clipped to the window; each trend entry keeps "day" (the bucket's first day) and adds "period_end".
--
-- Every existing parameter and result field is kept; the new ones are added at the END so a call that does not pass them behaves as before
-- (apart from the rejected Rent Plans now being counted). The old signatures are dropped first so a call can never be ambiguous.
-- Same role gate as the other reports: an enabled tenant_ops, coo, ceo or super_admin role.

DROP FUNCTION IF EXISTS public.awareness_coverage_gaps(timestamptz, timestamptz, text, text, integer, integer, text, text);
DROP FUNCTION IF EXISTS public.awareness_calls_summary(timestamptz, timestamptz, text, uuid, text, text, text, text, text, text, text);

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

CREATE OR REPLACE FUNCTION public.awareness_coverage_gaps(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_team text DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_district text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_outcome text DEFAULT NULL
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

  IF p_outcome IS NOT NULL AND p_outcome NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'invalid outcome: %, expected approved/rejected', p_outcome;
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
  -- Where a rejection happened, as a stage of this list. rejected_at_stage holds the status the Rent Plan was at when it was
  -- rejected; two legacy names are read as their current stages ('agent_verified' = Tenant Ops, 'coo' = COO approval). A rejection with
  -- no stage recorded counts at the Service centre when the Service centre had reviewed the Rent Plan.
  rej AS MATERIALIZED (
    SELECT rr.id AS rr_id,
           CASE
             WHEN rr.rejected_at_stage IS NOT NULL THEN
               CASE rr.rejected_at_stage WHEN 'agent_verified' THEN 'agent_ops_approved' WHEN 'coo' THEN 'partner_ops_approved' ELSE rr.rejected_at_stage END
             WHEN (rr.rejected_at IS NOT NULL OR rr.status = 'rejected') AND rr.service_center_reviewed_at IS NOT NULL THEN 'service_center_review'
           END AS rej_stage
    FROM public.rent_requests rr
  ),
  passed AS MATERIALIZED (
    SELECT rr.id AS rr_id, s.stage, s.team, s.ord, s.label,
           x.reviewed_at, x.reviewed_by, rj.rej_stage, rr.status AS cur_status, rr.rejected_at,
           -- moved past on the stage's reviewed-at time, or, for a rejection with no review time on that stage, on the rejection time
           COALESCE(x.reviewed_at, CASE WHEN rj.rej_stage = s.stage THEN rr.rejected_at END) AS passed_at,
           (rj.rej_stage = s.stage AND (rr.status = 'rejected' OR x.reviewed_at IS NULL)) AS rejected_here
    FROM public.rent_requests rr
    JOIN rej rj ON rj.rr_id = rr.id
    CROSS JOIN stg s
    CROSS JOIN LATERAL (
      SELECT CASE s.stage
               WHEN 'service_center_review' THEN rr.service_center_reviewed_at
               WHEN 'pending' THEN rr.agent_ops_reviewed_at
               WHEN 'agent_ops_approved' THEN rr.tenant_ops_reviewed_at
               WHEN 'tenant_ops_approved' THEN rr.landlord_ops_reviewed_at
               WHEN 'landlord_ops_approved' THEN rr.partner_ops_reviewed_at
               WHEN 'partner_ops_approved' THEN rr.coo_reviewed_at
               WHEN 'coo_approved' THEN rr.cfo_reviewed_at
             END AS reviewed_at,
             CASE s.stage
               WHEN 'service_center_review' THEN rr.service_center_reviewed_by
               WHEN 'pending' THEN rr.agent_ops_reviewed_by
               WHEN 'agent_ops_approved' THEN rr.tenant_ops_reviewed_by
               WHEN 'tenant_ops_approved' THEN rr.landlord_ops_reviewed_by
               WHEN 'landlord_ops_approved' THEN rr.partner_ops_reviewed_by
               WHEN 'partner_ops_approved' THEN rr.coo_reviewed_by
               WHEN 'coo_approved' THEN rr.cfo_reviewed_by
             END AS reviewed_by
    ) x
    WHERE (p_team IS NULL OR s.team = p_team)
  ),
  inwin AS MATERIALIZED (
    SELECT p.rr_id, p.stage, p.team, p.ord, p.label, p.passed_at, p.reviewed_by AS passed_by,
           (CASE WHEN p.rejected_here THEN 'rejected' ELSE 'approved' END) AS outcome
    FROM passed p
    WHERE p.passed_at >= v_start AND p.passed_at < v_end
      AND (p_outcome IS NULL OR p_outcome = (CASE WHEN p.rejected_here THEN 'rejected' ELSE 'approved' END))
      AND (p_status IS NULL OR p.rr_id IN (SELECT rr3.id FROM public.rent_requests rr3 WHERE rr3.status = p_status))
      AND ((p_region IS NULL AND p_district IS NULL) OR p.rr_id IN (
            SELECT rr2.id FROM public.rent_requests rr2
            JOIN public.v_tlb_tenant_base tb ON tb.tenant_id = rr2.tenant_id
            WHERE (p_region IS NULL OR tb.region = p_region)
              AND (p_district IS NULL OR tb.district_name = p_district)))
  ),
  marked AS MATERIALIZED (
    SELECT i.*,
           -- a call stored with the legacy status 'agent_verified' belongs to the Tenant Ops stage
           EXISTS (SELECT 1 FROM public.rent_pipeline_awareness_calls c
                   WHERE c.rent_request_id = i.rr_id
                     AND (c.pipeline_stage = i.stage OR (i.stage = 'agent_ops_approved' AND c.pipeline_stage = 'agent_verified'))) AS has_call
    FROM inwin i
  ),
  by_stage AS (
    SELECT s.stage, s.team, s.ord, s.label,
           count(m.rr_id)::int AS passed,
           count(m.rr_id) FILTER (WHERE m.has_call)::int AS with_call,
           count(m.rr_id) FILTER (WHERE NOT m.has_call)::int AS without_call,
           count(m.rr_id) FILTER (WHERE m.outcome = 'rejected')::int AS rejected
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
    'filters', jsonb_build_object('team', p_team, 'region', p_region, 'district', p_district, 'status', p_status, 'outcome', p_outcome),
    'tracking_started', (SELECT (MIN(c.recorded_at) AT TIME ZONE 'Africa/Kampala')::date FROM public.rent_pipeline_awareness_calls c),
    'basis', 'A Rent Plan moved past a stage on the day that stage''s reviewed-at time falls in the window, or, when it was rejected at that stage and the stage has no reviewed-at time, on the day it was rejected. The outcome is rejected when it was rejected at that stage, otherwise approved. It is a gap when no awareness call was recorded on that Rent Plan at that stage, by anyone, at any time.',
    'totals', jsonb_build_object(
      'passed', COALESCE((SELECT SUM(b.passed) FROM by_stage b), 0),
      'with_call', COALESCE((SELECT SUM(b.with_call) FROM by_stage b), 0),
      'without_call', COALESCE((SELECT SUM(b.without_call) FROM by_stage b), 0),
      'covered_pct', round(COALESCE((SELECT SUM(b.with_call) FROM by_stage b), 0)::numeric / NULLIF((SELECT SUM(b.passed) FROM by_stage b), 0) * 100, 1),
      'rejected', COALESCE((SELECT SUM(b.rejected) FROM by_stage b), 0)),
    'by_stage', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'stage', b.stage, 'label', b.label, 'team', b.team, 'passed', b.passed, 'with_call', b.with_call, 'without_call', b.without_call, 'rejected', b.rejected,
        'covered_pct', round(b.with_call::numeric / NULLIF(b.passed, 0) * 100, 1)) ORDER BY b.ord) FROM by_stage b), '[]'::jsonb),
    'total', (SELECT count(*) FROM gaps),
    'limit', v_limit,
    'offset', v_offset,
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'rent_request_id', p.rr_id, 'plan_code', left(p.rr_id::text, 8),
        'stage', p.stage, 'stage_label', p.label, 'team', p.team,
        'outcome', p.outcome,
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

REVOKE ALL ON FUNCTION public.awareness_coverage_gaps(timestamptz, timestamptz, text, text, integer, integer, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.awareness_coverage_gaps(timestamptz, timestamptz, text, text, integer, integer, text, text, text) TO authenticated;
