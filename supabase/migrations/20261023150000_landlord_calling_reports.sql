-- =============================================================================
-- Migration: 20261023150000_landlord_calling_reports.sql
-- Purpose:   Server-side read-only reporting RPCs for the Landlord Calling Center
--            Reports tab (`landlord_cc_*`).
--            - Kampala-day grouping (`AT TIME ZONE 'Africa/Kampala'`).
--            - Wednesday–Tuesday weeks matching Tenant Ops.
--            - Never edits `cc_weekly_all_calls_report` or any tenant report RPC.
--            - No money movement, no wallet/ledger/payout/Rent Plan writes.
-- =============================================================================

-- 1. Phone masking helper for Landlord Calling Center reports
--    Returns full phone only when caller holds an unmasked role (`landlord_ops`,
--    `operations`, `hr`, `coo`, `cfo`, `ceo`, `super_admin`); otherwise masks
--    middle digits via `public.crm_mask_phone`.
CREATE OR REPLACE FUNCTION public._landlord_cc_can_view_unmasked_phone()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    public.has_role(auth.uid(), 'landlord_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'hr'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );
$$;

REVOKE ALL ON FUNCTION public._landlord_cc_can_view_unmasked_phone() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._landlord_cc_can_view_unmasked_phone() TO authenticated, service_role;

-- 2. Canonical internal helper: `_landlord_cc_events_in_window(p_from, p_to)`
--    Single source of truth for landlord call events in a Kampala timestamp range
--    `[p_from, p_to)`. Used by `landlord_cc_daily_summary`, `landlord_cc_weekly_report`,
--    `landlord_cc_staff_performance`, and `landlord_cc_landlord_call_log` so that
--    daily sums, weekly totals, and staff totals reconcile 100% by construction.
--    Voided attempts (`void_reason IS NOT NULL`) are excluded.
CREATE OR REPLACE FUNCTION public._landlord_cc_events_in_window(
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  call_id uuid,
  called_at timestamptz,
  kampala_day date,
  caller_id uuid,
  caller_name text,
  landlord_key uuid,
  landlord_name text,
  raw_phone text,
  source text,
  direction text,
  outcome text,
  is_engaged boolean,
  is_reached boolean,
  is_callback boolean,
  is_unreachable boolean,
  category_code text,
  category_label text,
  note text,
  cycle_row_id uuid,
  received_call_id uuid,
  feedback_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH raw_events AS (
    -- A. Outbound Landlord Calling Center attempts (non-voided, recorded or revealed)
    SELECT
      a.id AS call_id,
      COALESCE(a.recorded_at, a.revealed_at, a.created_at) AS called_at,
      a.caller_id,
      NULL::text AS fallback_caller_name,
      r.subject_id AS person_id,
      NULL::uuid AS rr_id,
      NULL::text AS fallback_landlord_name,
      NULL::text AS fallback_phone,
      'calling_center'::text AS source,
      'made'::text AS direction,
      1 AS prio,
      COALESCE(a.outcome::text, 'open') AS outcome,
      (a.outcome = 'engaged'::cc_attempt_outcome) AS is_engaged,
      (a.outcome IN ('engaged'::cc_attempt_outcome, 'callback_booked'::cc_attempt_outcome)) AS is_reached,
      (a.outcome = 'callback_booked'::cc_attempt_outcome) AS is_callback,
      (a.outcome IS NULL OR a.outcome NOT IN ('engaged'::cc_attempt_outcome, 'callback_booked'::cc_attempt_outcome)) AS is_unreachable,
      cat.code AS category_code,
      cat.label AS category_label,
      COALESCE(fb.note, a.legacy_note) AS note,
      r.id AS cycle_row_id,
      NULL::uuid AS received_call_id,
      fb.id AS feedback_id
    FROM public.cc_call_attempts a
    JOIN public.cc_cycle_rows r ON r.id = a.cycle_row_id
    LEFT JOIN LATERAL (
      SELECT f.id, f.category_id, f.note
      FROM public.cc_feedback f
      WHERE f.attempt_id = a.id
      ORDER BY f.created_at DESC
      LIMIT 1
    ) fb ON true
    LEFT JOIN public.cc_feedback_categories cat ON cat.id = fb.category_id
    WHERE r.subject_type = 'landlord'::cc_subject_type
      AND a.void_reason IS NULL
      AND COALESCE(a.recorded_at, a.revealed_at, a.created_at) >= p_from
      AND COALESCE(a.recorded_at, a.revealed_at, a.created_at) < p_to

    UNION ALL

    -- B. Inbound landlord calls recorded in cc_received_calls
    SELECT
      c.id AS call_id,
      c.called_at,
      c.recorded_by AS caller_id,
      c.recorded_by_name AS fallback_caller_name,
      c.linked_user_id AS person_id,
      NULL::uuid AS rr_id,
      c.caller_name AS fallback_landlord_name,
      c.caller_phone AS fallback_phone,
      'received'::text AS source,
      'received'::text AS direction,
      1 AS prio,
      'engaged'::text AS outcome,
      true AS is_engaged,
      true AS is_reached,
      (c.follow_up_at IS NOT NULL) AS is_callback,
      false AS is_unreachable,
      'received_call'::text AS category_code,
      'Received call'::text AS category_label,
      COALESCE(NULLIF(btrim(COALESCE(c.concern, '')), ''), c.notes) AS note,
      NULL::uuid AS cycle_row_id,
      c.id AS received_call_id,
      NULL::uuid AS feedback_id
    FROM public.cc_received_calls c
    WHERE c.linked_kind = 'landlord'
      AND c.called_at >= p_from
      AND c.called_at < p_to

    UNION ALL

    -- C. Rent pipeline landlord awareness calls
    SELECT
      w.id AS call_id,
      COALESCE(w.recorded_at, w.dial_started_at) AS called_at,
      w.caller_id,
      NULL::text AS fallback_caller_name,
      COALESCE(w.subject_user_id, rr.landlord_id) AS person_id,
      w.rent_request_id AS rr_id,
      l.name AS fallback_landlord_name,
      COALESCE(w.subject_phone, l.phone) AS fallback_phone,
      'awareness'::text AS source,
      'made'::text AS direction,
      2 AS prio,
      COALESCE(w.call_result, 'no_answer') AS outcome,
      (w.call_result = 'answered') AS is_engaged,
      (w.call_result IN ('answered', 'call_back_later')) AS is_reached,
      (w.call_result = 'call_back_later') AS is_callback,
      (w.call_result IS NULL OR w.call_result NOT IN ('answered', 'call_back_later')) AS is_unreachable,
      CASE
        WHEN w.landlord_consent IS NOT NULL THEN 'landlord_consent_' || w.landlord_consent
        ELSE 'awareness_call'
      END AS category_code,
      'Pipeline awareness'::text AS category_label,
      w.note,
      NULL::uuid AS cycle_row_id,
      NULL::uuid AS received_call_id,
      NULL::uuid AS feedback_id
    FROM public.rent_pipeline_awareness_calls w
    LEFT JOIN public.rent_requests rr ON rr.id = w.rent_request_id
    LEFT JOIN public.landlords l ON l.id = COALESCE(w.subject_user_id, rr.landlord_id)
    WHERE w.subject_type = 'landlord'
      AND COALESCE(w.recorded_at, w.dial_started_at) >= p_from
      AND COALESCE(w.recorded_at, w.dial_started_at) < p_to

    UNION ALL

    -- D. Landlord Ops pipeline verification phone calls on rent_requests
    SELECT
      q.id AS call_id,
      q.landlord_ops_reviewed_at AS called_at,
      q.landlord_ops_reviewed_by AS caller_id,
      NULL::text AS fallback_caller_name,
      q.landlord_id AS person_id,
      q.id AS rr_id,
      l.name AS fallback_landlord_name,
      l.phone AS fallback_phone,
      'pipeline_landlord'::text AS source,
      'made'::text AS direction,
      3 AS prio,
      CASE WHEN COALESCE(q.landlord_acknowledged, false) THEN 'engaged' ELSE 'no_answer' END AS outcome,
      COALESCE(q.landlord_acknowledged, false) AS is_engaged,
      COALESCE(q.landlord_acknowledged, false) AS is_reached,
      false AS is_callback,
      NOT COALESCE(q.landlord_acknowledged, false) AS is_unreachable,
      'pipeline_verification'::text AS category_code,
      'Landlord verification'::text AS category_label,
      NULL::text AS note,
      NULL::uuid AS cycle_row_id,
      NULL::uuid AS received_call_id,
      NULL::uuid AS feedback_id
    FROM public.rent_requests q
    LEFT JOIN public.landlords l ON l.id = q.landlord_id
    WHERE q.landlord_called IS TRUE
      AND q.landlord_verification_method = 'phone_call'
      AND q.landlord_ops_reviewed_by IS NOT NULL
      AND q.landlord_ops_reviewed_at IS NOT NULL
      AND q.landlord_ops_reviewed_at >= p_from
      AND q.landlord_ops_reviewed_at < p_to

    UNION ALL

    -- E. In-app CRM voice sessions to landlords
    SELECT
      s.id AS call_id,
      s.created_at AS called_at,
      s.staff_id AS caller_id,
      NULL::text AS fallback_caller_name,
      s.target_user_id AS person_id,
      NULL::uuid AS rr_id,
      s.target_name AS fallback_landlord_name,
      s.target_phone AS fallback_phone,
      'crm_voice'::text AS source,
      CASE WHEN s.direction = 'inbound' THEN 'received' ELSE 'made' END AS direction,
      4 AS prio,
      CASE WHEN s.answered_at IS NOT NULL THEN 'engaged' ELSE COALESCE(s.status, 'no_answer') END AS outcome,
      (s.answered_at IS NOT NULL) AS is_engaged,
      (s.answered_at IS NOT NULL) AS is_reached,
      false AS is_callback,
      (s.answered_at IS NULL) AS is_unreachable,
      'crm_voice'::text AS category_code,
      'App voice call'::text AS category_label,
      s.summary AS note,
      NULL::uuid AS cycle_row_id,
      NULL::uuid AS received_call_id,
      NULL::uuid AS feedback_id
    FROM public.crm_call_sessions s
    WHERE s.target_role = 'landlord'
      AND s.created_at >= p_from
      AND s.created_at < p_to

    UNION ALL

    -- F. Legacy landlord call reports
    SELECT
      lcr.id AS call_id,
      lcr.called_at,
      lcr.called_by AS caller_id,
      NULL::text AS fallback_caller_name,
      lcr.landlord_id AS person_id,
      NULL::uuid AS rr_id,
      l.name AS fallback_landlord_name,
      l.phone AS fallback_phone,
      'legacy_landlord'::text AS source,
      'made'::text AS direction,
      5 AS prio,
      CASE
        WHEN lcr.status = 'picked_up' THEN 'engaged'
        WHEN lcr.follow_up_at IS NOT NULL THEN 'callback_booked'
        ELSE COALESCE(lcr.status, 'no_answer')
      END AS outcome,
      (lcr.status = 'picked_up') AS is_engaged,
      (lcr.status = 'picked_up' OR lcr.follow_up_at IS NOT NULL) AS is_reached,
      (lcr.follow_up_at IS NOT NULL AND lcr.status <> 'picked_up') AS is_callback,
      (lcr.status IS DISTINCT FROM 'picked_up' AND lcr.follow_up_at IS NULL) AS is_unreachable,
      'legacy_landlord'::text AS category_code,
      'Earlier landlord call log'::text AS category_label,
      lcr.comment AS note,
      NULL::uuid AS cycle_row_id,
      NULL::uuid AS received_call_id,
      NULL::uuid AS feedback_id
    FROM public.landlord_call_reports lcr
    LEFT JOIN public.landlords l ON l.id = lcr.landlord_id
    WHERE lcr.called_at >= p_from
      AND lcr.called_at < p_to
  ),
  in_window AS MATERIALIZED (
    SELECT e.*
    FROM raw_events e
    WHERE e.called_at IS NOT NULL
      AND e.called_at >= p_from
      AND e.called_at < p_to
  ),
  -- Deduplicate within 15 minutes across multi-written call tables (same rule as cc_weekly_all_calls_report)
  kept AS MATERIALIZED (
    SELECT m.*
    FROM in_window m
    WHERE NOT EXISTS (
      SELECT 1
      FROM in_window h
      WHERE h.prio < m.prio
        AND m.caller_id IS NOT NULL
        AND h.caller_id = m.caller_id
        AND abs(extract(epoch FROM (h.called_at - m.called_at))) <= 15 * 60
        AND (
          (h.person_id IS NOT NULL AND h.person_id = m.person_id)
          OR (h.rr_id IS NOT NULL AND h.rr_id = m.rr_id)
        )
    )
  )
  SELECT
    k.call_id,
    k.called_at,
    (k.called_at AT TIME ZONE 'Africa/Kampala')::date AS kampala_day,
    k.caller_id,
    COALESCE(NULLIF(btrim(cp.full_name), ''), NULLIF(btrim(k.fallback_caller_name), ''), 'Call centre officer') AS caller_name,
    k.person_id AS landlord_key,
    COALESCE(NULLIF(btrim(ll.name), ''), NULLIF(btrim(k.fallback_landlord_name), ''), NULLIF(btrim(lp.full_name), ''), 'Unnamed Landlord') AS landlord_name,
    COALESCE(
      public.normalize_landlord_phone_256(COALESCE(ll.phone, ll.mobile_money_number)),
      public.normalize_landlord_phone_256(k.fallback_phone),
      public.normalize_landlord_phone_256(COALESCE(lp.phone, lp.mobile_money_number)),
      NULLIF(btrim(COALESCE(ll.phone, k.fallback_phone, lp.phone, '')), '')
    ) AS raw_phone,
    k.source,
    k.direction,
    k.outcome,
    k.is_engaged,
    k.is_reached,
    k.is_callback,
    k.is_unreachable,
    k.category_code,
    k.category_label,
    k.note,
    k.cycle_row_id,
    k.received_call_id,
    k.feedback_id
  FROM kept k
  LEFT JOIN public.profiles cp ON cp.id = k.caller_id
  LEFT JOIN public.landlords ll ON ll.id = k.person_id
  LEFT JOIN public.profiles lp ON lp.id = k.person_id;
$$;

REVOKE ALL ON FUNCTION public._landlord_cc_events_in_window(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._landlord_cc_events_in_window(timestamptz, timestamptz) TO authenticated, service_role;

-- =============================================================================
-- RPC 1: landlord_cc_daily_summary(p_from date, p_to date)
-- Per staff/day calls, reached (engaged), unreachable, callbacks; voided excluded.
-- Grouped by Kampala day.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.landlord_cc_daily_summary(
  p_from date,
  p_to date
)
RETURNS TABLE (
  kampala_day date,
  staff_id uuid,
  staff_name text,
  total_calls integer,
  engaged_calls integer,
  reached_calls integer,
  unreachable_calls integer,
  callback_calls integer,
  made_calls integer,
  received_calls integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from timestamptz;
  v_to   timestamptz;
BEGIN
  IF NOT (pg_trigger_depth() > 0 OR auth.uid() IS NULL OR public._landlord_cc_staff_ok()) THEN
    RAISE EXCEPTION 'Not authorized to view Landlord Calling Center reports'
      USING ERRCODE = '42501';
  END IF;

  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RETURN;
  END IF;

  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');

  RETURN QUERY
  SELECT
    e.kampala_day,
    e.caller_id AS staff_id,
    e.caller_name AS staff_name,
    count(*)::integer AS total_calls,
    count(*) FILTER (WHERE e.is_engaged)::integer AS engaged_calls,
    count(*) FILTER (WHERE e.is_reached)::integer AS reached_calls,
    count(*) FILTER (WHERE e.is_unreachable)::integer AS unreachable_calls,
    count(*) FILTER (WHERE e.is_callback)::integer AS callback_calls,
    count(*) FILTER (WHERE e.direction = 'made')::integer AS made_calls,
    count(*) FILTER (WHERE e.direction = 'received')::integer AS received_calls
  FROM public._landlord_cc_events_in_window(v_from, v_to) e
  GROUP BY e.kampala_day, e.caller_id, e.caller_name
  ORDER BY e.kampala_day DESC, total_calls DESC, e.caller_name ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.landlord_cc_daily_summary(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landlord_cc_daily_summary(date, date) TO authenticated, service_role;

-- =============================================================================
-- RPC 2: landlord_cc_weekly_report(p_week_start date)
-- Wednesday–Tuesday weeks matching Tenant Ops.
-- Returns structured JSONB containing:
--   - week_start (Wednesday) and week_end (Tuesday), day_keys (7 dates)
--   - totals (total_calls, engaged_calls, reached_calls, unreachable_calls,
--     callback_calls, made_calls, received_calls, forwarded_total, solved_here_total)
--   - staff_calls: per-staff daily call counts + breakdown by source
--   - forwarded_by_recipient: per-recipient daily forwarded landlord concerns + made vs received
--   - solved_here_by_staff: per-staff daily calls resolved at the calling center without forwarding
--   - per_day: 7-day breakdown of calls made, received, engaged, forwarded, solved_here
-- =============================================================================
CREATE OR REPLACE FUNCTION public.landlord_cc_weekly_report(
  p_week_start date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_anchor date;
  v_dow int;
  v_back int;
  v_week_start date;
  v_week_end date;
  v_from timestamptz;
  v_to timestamptz;
  v_result jsonb;
BEGIN
  IF NOT (pg_trigger_depth() > 0 OR auth.uid() IS NULL OR public._landlord_cc_staff_ok()) THEN
    RAISE EXCEPTION 'Not authorized to view Landlord Calling Center weekly report'
      USING ERRCODE = '42501';
  END IF;

  -- Snap any date to its enclosing Wednesday–Tuesday week in Kampala time
  v_anchor := COALESCE(p_week_start, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_dow := extract(dow FROM v_anchor)::int; -- 0=Sun..3=Wed..6=Sat
  v_back := (v_dow - 3 + 7) % 7;
  v_week_start := v_anchor - v_back;
  v_week_end := v_week_start + 6;

  v_from := (v_week_start::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((v_week_end + 1)::timestamp AT TIME ZONE 'Africa/Kampala');

  WITH days AS MATERIALIZED (
    SELECT
      (v_week_start + i)::date AS kampala_day,
      i AS day_idx
    FROM generate_series(0, 6) AS i
  ),
  ev AS MATERIALIZED (
    SELECT *
    FROM public._landlord_cc_events_in_window(v_from, v_to)
  ),
  -- Landlord forwarded concerns in this week
  concerns AS MATERIALIZED (
    SELECT
      c.id,
      c.source_kind,
      c.received_call_id,
      c.cycle_row_id,
      c.feedback_id,
      c.forwarded_to,
      COALESCE(NULLIF(btrim(c.forwarded_to_name), ''), 'Staff member') AS recipient_name,
      c.status,
      c.priority,
      (c.created_at AT TIME ZONE 'Africa/Kampala')::date AS kampala_day
    FROM public.cc_forwarded_concerns c
    WHERE c.created_at >= v_from
      AND c.created_at < v_to
      AND (
        c.subject_type = 'landlord'
        OR EXISTS (
          SELECT 1 FROM public.cc_cycle_rows r
          WHERE r.id = c.cycle_row_id AND r.subject_type = 'landlord'::cc_subject_type
        )
        OR EXISTS (
          SELECT 1 FROM public.cc_received_calls rc
          WHERE rc.id = c.received_call_id AND rc.linked_kind = 'landlord'
        )
      )
  ),
  -- Calls resolved at the Calling Center ("solved here"):
  -- engaged outbound or resolved/closed received call with no forwarded concern
  solved_events AS MATERIALIZED (
    SELECT
      e.*
    FROM ev e
    WHERE e.is_reached
      AND NOT EXISTS (
        SELECT 1 FROM concerns c
        WHERE (e.cycle_row_id IS NOT NULL AND c.cycle_row_id = e.cycle_row_id)
           OR (e.received_call_id IS NOT NULL AND c.received_call_id = e.received_call_id)
           OR (e.feedback_id IS NOT NULL AND c.feedback_id = e.feedback_id)
      )
  ),
  staff_daily AS (
    SELECT
      e.caller_id,
      e.caller_name,
      count(*)::int AS total_calls,
      count(*) FILTER (WHERE e.is_engaged)::int AS engaged_calls,
      count(*) FILTER (WHERE e.is_reached)::int AS reached_calls,
      count(*) FILTER (WHERE e.is_unreachable)::int AS unreachable_calls,
      count(*) FILTER (WHERE e.is_callback)::int AS callback_calls,
      count(*) FILTER (WHERE e.direction = 'made')::int AS made_calls,
      count(*) FILTER (WHERE e.direction = 'received')::int AS received_calls,
      ARRAY[
        count(*) FILTER (WHERE e.kampala_day = v_week_start)::int,
        count(*) FILTER (WHERE e.kampala_day = v_week_start + 1)::int,
        count(*) FILTER (WHERE e.kampala_day = v_week_start + 2)::int,
        count(*) FILTER (WHERE e.kampala_day = v_week_start + 3)::int,
        count(*) FILTER (WHERE e.kampala_day = v_week_start + 4)::int,
        count(*) FILTER (WHERE e.kampala_day = v_week_start + 5)::int,
        count(*) FILTER (WHERE e.kampala_day = v_week_start + 6)::int
      ] AS per_day
    FROM ev e
    GROUP BY e.caller_id, e.caller_name
  ),
  fwd_recipient AS (
    SELECT
      c.forwarded_to AS recipient_id,
      c.recipient_name,
      count(*)::int AS total_forwarded,
      count(*) FILTER (WHERE c.source_kind = 'outbound_call')::int AS from_made,
      count(*) FILTER (WHERE c.source_kind = 'received_call')::int AS from_received,
      ARRAY[
        count(*) FILTER (WHERE c.kampala_day = v_week_start)::int,
        count(*) FILTER (WHERE c.kampala_day = v_week_start + 1)::int,
        count(*) FILTER (WHERE c.kampala_day = v_week_start + 2)::int,
        count(*) FILTER (WHERE c.kampala_day = v_week_start + 3)::int,
        count(*) FILTER (WHERE c.kampala_day = v_week_start + 4)::int,
        count(*) FILTER (WHERE c.kampala_day = v_week_start + 5)::int,
        count(*) FILTER (WHERE c.kampala_day = v_week_start + 6)::int
      ] AS per_day
    FROM concerns c
    GROUP BY c.forwarded_to, c.recipient_name
  ),
  solved_staff AS (
    SELECT
      s.caller_id AS staff_id,
      s.caller_name AS staff_name,
      count(*)::int AS total_solved,
      count(*) FILTER (WHERE s.direction = 'made')::int AS from_made,
      count(*) FILTER (WHERE s.direction = 'received')::int AS from_received,
      ARRAY[
        count(*) FILTER (WHERE s.kampala_day = v_week_start)::int,
        count(*) FILTER (WHERE s.kampala_day = v_week_start + 1)::int,
        count(*) FILTER (WHERE s.kampala_day = v_week_start + 2)::int,
        count(*) FILTER (WHERE s.kampala_day = v_week_start + 3)::int,
        count(*) FILTER (WHERE s.kampala_day = v_week_start + 4)::int,
        count(*) FILTER (WHERE s.kampala_day = v_week_start + 5)::int,
        count(*) FILTER (WHERE s.kampala_day = v_week_start + 6)::int
      ] AS per_day
    FROM solved_events s
    GROUP BY s.caller_id, s.caller_name
  ),
  day_rollup AS (
    SELECT
      d.kampala_day,
      d.day_idx,
      (SELECT count(*)::int FROM ev e WHERE e.kampala_day = d.kampala_day) AS total_calls,
      (SELECT count(*)::int FROM ev e WHERE e.kampala_day = d.kampala_day AND e.is_engaged) AS engaged_calls,
      (SELECT count(*)::int FROM ev e WHERE e.kampala_day = d.kampala_day AND e.is_reached) AS reached_calls,
      (SELECT count(*)::int FROM ev e WHERE e.kampala_day = d.kampala_day AND e.is_unreachable) AS unreachable_calls,
      (SELECT count(*)::int FROM ev e WHERE e.kampala_day = d.kampala_day AND e.is_callback) AS callback_calls,
      (SELECT count(*)::int FROM ev e WHERE e.kampala_day = d.kampala_day AND e.direction = 'made') AS made_calls,
      (SELECT count(*)::int FROM ev e WHERE e.kampala_day = d.kampala_day AND e.direction = 'received') AS received_calls,
      (SELECT count(*)::int FROM concerns c WHERE c.kampala_day = d.kampala_day) AS forwarded_total,
      (SELECT count(*)::int FROM concerns c WHERE c.kampala_day = d.kampala_day AND c.source_kind = 'outbound_call') AS forwarded_from_made,
      (SELECT count(*)::int FROM concerns c WHERE c.kampala_day = d.kampala_day AND c.source_kind = 'received_call') AS forwarded_from_received,
      (SELECT count(*)::int FROM solved_events s WHERE s.kampala_day = d.kampala_day) AS solved_here_total
    FROM days d
    ORDER BY d.day_idx
  ),
  by_source AS (
    SELECT
      e.source,
      count(*)::int AS calls,
      count(*) FILTER (WHERE e.is_reached)::int AS reached_calls
    FROM ev e
    GROUP BY e.source
    ORDER BY calls DESC, e.source
  )
  SELECT jsonb_build_object(
    'week_start', v_week_start,
    'week_end', v_week_end,
    'day_keys', (SELECT jsonb_agg(d.kampala_day ORDER BY d.day_idx) FROM days d),
    'totals', jsonb_build_object(
      'total_calls', (SELECT count(*)::int FROM ev),
      'engaged_calls', (SELECT count(*) FILTER (WHERE is_engaged)::int FROM ev),
      'reached_calls', (SELECT count(*) FILTER (WHERE is_reached)::int FROM ev),
      'unreachable_calls', (SELECT count(*) FILTER (WHERE is_unreachable)::int FROM ev),
      'callback_calls', (SELECT count(*) FILTER (WHERE is_callback)::int FROM ev),
      'made_calls', (SELECT count(*) FILTER (WHERE direction = 'made')::int FROM ev),
      'received_calls', (SELECT count(*) FILTER (WHERE direction = 'received')::int FROM ev),
      'forwarded_total', (SELECT count(*)::int FROM concerns),
      'forwarded_from_made', (SELECT count(*) FILTER (WHERE source_kind = 'outbound_call')::int FROM concerns),
      'forwarded_from_received', (SELECT count(*) FILTER (WHERE source_kind = 'received_call')::int FROM concerns),
      'solved_here_total', (SELECT count(*)::int FROM solved_events)
    ),
    'staff_calls', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'staff_id', sd.caller_id,
          'staff_name', sd.caller_name,
          'total_calls', sd.total_calls,
          'engaged_calls', sd.engaged_calls,
          'reached_calls', sd.reached_calls,
          'unreachable_calls', sd.unreachable_calls,
          'callback_calls', sd.callback_calls,
          'made_calls', sd.made_calls,
          'received_calls', sd.received_calls,
          'per_day', to_jsonb(sd.per_day)
        )
        ORDER BY sd.total_calls DESC, sd.caller_name ASC
      )
      FROM staff_daily sd
    ), '[]'::jsonb),
    'forwarded_by_recipient', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'recipient_id', fr.recipient_id,
          'recipient_name', fr.recipient_name,
          'total_forwarded', fr.total_forwarded,
          'from_made', fr.from_made,
          'from_received', fr.from_received,
          'per_day', to_jsonb(fr.per_day)
        )
        ORDER BY fr.total_forwarded DESC, fr.recipient_name ASC
      )
      FROM fwd_recipient fr
    ), '[]'::jsonb),
    'solved_here_by_staff', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'staff_id', ss.staff_id,
          'staff_name', ss.staff_name,
          'total_solved', ss.total_solved,
          'from_made', ss.from_made,
          'from_received', ss.from_received,
          'per_day', to_jsonb(ss.per_day)
        )
        ORDER BY ss.total_solved DESC, ss.staff_name ASC
      )
      FROM solved_staff ss
    ), '[]'::jsonb),
    'per_day', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'kampala_day', dr.kampala_day,
          'total_calls', dr.total_calls,
          'engaged_calls', dr.engaged_calls,
          'reached_calls', dr.reached_calls,
          'unreachable_calls', dr.unreachable_calls,
          'callback_calls', dr.callback_calls,
          'made_calls', dr.made_calls,
          'received_calls', dr.received_calls,
          'forwarded_total', dr.forwarded_total,
          'forwarded_from_made', dr.forwarded_from_made,
          'forwarded_from_received', dr.forwarded_from_received,
          'solved_here_total', dr.solved_here_total
        )
        ORDER BY dr.day_idx
      )
      FROM day_rollup dr
    ), '[]'::jsonb),
    'by_source', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'source', bs.source,
          'calls', bs.calls,
          'reached_calls', bs.reached_calls
        )
      )
      FROM by_source bs
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.landlord_cc_weekly_report(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landlord_cc_weekly_report(date) TO authenticated, service_role;

-- =============================================================================
-- RPC 3: landlord_cc_coverage(p_as_at timestamptz)
-- Registry total, ever reached, reached this round, reached this month,
-- never called — broken down by region and district over `v_landlord_registry_all`.
-- Guaranteed: ever_reached <= registry_total, reached_this_round <= registry_total,
-- reached_this_month <= registry_total, never_called <= registry_total.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.landlord_cc_coverage(
  p_as_at timestamptz DEFAULT now()
)
RETURNS TABLE (
  region text,
  district text,
  registry_total integer,
  ever_reached integer,
  reached_this_round integer,
  reached_this_month integer,
  never_called integer,
  called_but_unreached integer,
  needs_review_count integer,
  active_rent_plans_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_as_at timestamptz := COALESCE(p_as_at, now());
  v_month_start timestamptz;
  v_cycle_id uuid;
BEGIN
  IF NOT (pg_trigger_depth() > 0 OR auth.uid() IS NULL OR public._landlord_cc_staff_ok()) THEN
    RAISE EXCEPTION 'Not authorized to view Landlord Calling Center coverage'
      USING ERRCODE = '42501';
  END IF;

  -- First day of the Kampala month containing v_as_at
  v_month_start := (date_trunc('month', v_as_at AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala');

  -- Latest landlord calling cycle opened at or before v_as_at
  SELECT c.id INTO v_cycle_id
  FROM public.cc_call_cycles c
  WHERE c.subject_type = 'landlord'::cc_subject_type
    AND c.opened_at <= v_as_at
  ORDER BY (c.closed_at IS NULL) DESC, c.opened_at DESC
  LIMIT 1;

  RETURN QUERY
  WITH reached_events AS (
    -- Reached calls from cc_call_attempts up to v_as_at
    SELECT
      r.subject_id,
      COALESCE(a.recorded_at, a.revealed_at, a.created_at) AS ts,
      r.cycle_id
    FROM public.cc_call_attempts a
    JOIN public.cc_cycle_rows r ON r.id = a.cycle_row_id
    WHERE r.subject_type = 'landlord'::cc_subject_type
      AND a.void_reason IS NULL
      AND a.outcome IN ('engaged'::cc_attempt_outcome, 'callback_booked'::cc_attempt_outcome)
      AND COALESCE(a.recorded_at, a.revealed_at, a.created_at) <= v_as_at

    UNION ALL

    -- Reached calls from rent_pipeline_awareness_calls up to v_as_at
    SELECT
      COALESCE(w.subject_user_id, rr.landlord_id) AS subject_id,
      COALESCE(w.recorded_at, w.dial_started_at) AS ts,
      NULL::uuid AS cycle_id
    FROM public.rent_pipeline_awareness_calls w
    LEFT JOIN public.rent_requests rr ON rr.id = w.rent_request_id
    WHERE w.subject_type = 'landlord'
      AND w.call_result IN ('answered', 'call_back_later')
      AND COALESCE(w.subject_user_id, rr.landlord_id) IS NOT NULL
      AND COALESCE(w.recorded_at, w.dial_started_at) <= v_as_at

    UNION ALL

    -- Reached calls from landlord_ops verification calls up to v_as_at
    SELECT
      q.landlord_id AS subject_id,
      q.landlord_ops_reviewed_at AS ts,
      NULL::uuid AS cycle_id
    FROM public.rent_requests q
    WHERE q.landlord_id IS NOT NULL
      AND q.landlord_called IS TRUE
      AND q.landlord_verification_method = 'phone_call'
      AND COALESCE(q.landlord_acknowledged, false) IS TRUE
      AND q.landlord_ops_reviewed_at <= v_as_at

    UNION ALL

    -- Reached calls from legacy landlord_call_reports up to v_as_at
    SELECT
      lcr.landlord_id AS subject_id,
      lcr.called_at AS ts,
      NULL::uuid AS cycle_id
    FROM public.landlord_call_reports lcr
    WHERE lcr.landlord_id IS NOT NULL
      AND lcr.status = 'picked_up'
      AND lcr.called_at <= v_as_at

    UNION ALL

    -- Reached calls from crm_call_sessions up to v_as_at
    SELECT
      s.target_user_id AS subject_id,
      s.created_at AS ts,
      NULL::uuid AS cycle_id
    FROM public.crm_call_sessions s
    WHERE s.target_role = 'landlord'
      AND s.target_user_id IS NOT NULL
      AND s.answered_at IS NOT NULL
      AND s.created_at <= v_as_at
  ),
  reached_by_subject AS (
    SELECT
      re.subject_id,
      true AS is_ever_reached,
      bool_or(re.ts >= v_month_start) AS is_reached_month,
      bool_or(v_cycle_id IS NOT NULL AND re.cycle_id = v_cycle_id) AS is_reached_round_attempt
    FROM reached_events re
    WHERE re.subject_id IS NOT NULL
    GROUP BY re.subject_id
  ),
  round_engaged_rows AS (
    SELECT DISTINCT r.subject_id
    FROM public.cc_cycle_rows r
    WHERE v_cycle_id IS NOT NULL
      AND r.cycle_id = v_cycle_id
      AND r.subject_type = 'landlord'::cc_subject_type
      AND r.state IN ('engaged'::cc_row_state, 'callback'::cc_row_state)
  ),
  registry_enriched AS (
    SELECT
      COALESCE(NULLIF(btrim(reg.region), ''), 'Unspecified') AS region_label,
      COALESCE(NULLIF(btrim(reg.district), ''), 'Unspecified') AS district_label,
      reg.landlord_key,
      reg.needs_review,
      reg.active_rent_plans,
      (reg.last_called_at IS NULL OR reg.last_called_at > v_as_at) AS is_never_called,
      (
        COALESCE(rk.is_ever_reached, false)
        OR COALESCE(ru.is_ever_reached, false)
        OR (reg.last_called_at IS NOT NULL AND reg.last_called_at <= v_as_at AND reg.last_call_outcome IN (
          'engaged', 'callback_booked', 'reached_ok', 'confirmed_payout_number',
          'wants_more_tenants', 'complaint', 'payout_issue', 'answered', 'picked_up'
        ))
      ) AS is_ever_reached,
      (
        COALESCE(rk.is_reached_month, false)
        OR COALESCE(ru.is_reached_month, false)
        OR (reg.last_called_at IS NOT NULL AND reg.last_called_at >= v_month_start AND reg.last_called_at <= v_as_at AND reg.last_call_outcome IN (
          'engaged', 'callback_booked', 'reached_ok', 'confirmed_payout_number',
          'wants_more_tenants', 'complaint', 'payout_issue', 'answered', 'picked_up'
        ))
      ) AS is_reached_this_month,
      (
        COALESCE(rk.is_reached_round_attempt, false)
        OR COALESCE(ru.is_reached_round_attempt, false)
        OR rrk.subject_id IS NOT NULL
        OR rru.subject_id IS NOT NULL
      ) AS is_reached_this_round
    FROM public.v_landlord_registry_all reg
    LEFT JOIN reached_by_subject rk ON rk.subject_id = reg.landlord_key
    LEFT JOIN reached_by_subject ru ON reg.user_id IS NOT NULL AND reg.user_id <> reg.landlord_key AND ru.subject_id = reg.user_id
    LEFT JOIN round_engaged_rows rrk ON rrk.subject_id = reg.landlord_key
    LEFT JOIN round_engaged_rows rru ON reg.user_id IS NOT NULL AND reg.user_id <> reg.landlord_key AND rru.subject_id = reg.user_id
  )
  SELECT
    re.region_label AS region,
    re.district_label AS district,
    count(*)::integer AS registry_total,
    count(*) FILTER (WHERE re.is_ever_reached)::integer AS ever_reached,
    count(*) FILTER (WHERE re.is_reached_this_round)::integer AS reached_this_round,
    count(*) FILTER (WHERE re.is_reached_this_month)::integer AS reached_this_month,
    count(*) FILTER (WHERE re.is_never_called)::integer AS never_called,
    count(*) FILTER (WHERE NOT re.is_never_called AND NOT re.is_ever_reached)::integer AS called_but_unreached,
    count(*) FILTER (WHERE re.needs_review)::integer AS needs_review_count,
    count(*) FILTER (WHERE re.active_rent_plans > 0)::integer AS active_rent_plans_count
  FROM registry_enriched re
  GROUP BY re.region_label, re.district_label
  ORDER BY count(*) DESC, re.region_label ASC, re.district_label ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.landlord_cc_coverage(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landlord_cc_coverage(timestamptz) TO authenticated, service_role;

-- =============================================================================
-- RPC 4: landlord_cc_staff_performance(p_from date, p_to date)
-- Calls, reach rate, calls per active hour, follow-ups owed/overdue.
-- Uses `_landlord_cc_events_in_window` so total_calls / engaged_calls /
-- reached_calls / unreachable_calls / callback_calls sum identically to
-- `landlord_cc_daily_summary` and `landlord_cc_weekly_report`.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.landlord_cc_staff_performance(
  p_from date,
  p_to date
)
RETURNS TABLE (
  staff_id uuid,
  staff_name text,
  total_calls integer,
  engaged_calls integer,
  reached_calls integer,
  unreachable_calls integer,
  callback_calls integer,
  unique_landlords integer,
  reach_rate_pct numeric,
  active_hours integer,
  calls_per_active_hour numeric,
  followups_owed integer,
  followups_overdue integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from timestamptz;
  v_to   timestamptz;
BEGIN
  IF NOT (pg_trigger_depth() > 0 OR auth.uid() IS NULL OR public._landlord_cc_staff_ok()) THEN
    RAISE EXCEPTION 'Not authorized to view Landlord Calling Center staff performance'
      USING ERRCODE = '42501';
  END IF;

  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RETURN;
  END IF;

  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');

  RETURN QUERY
  WITH ev AS MATERIALIZED (
    SELECT *
    FROM public._landlord_cc_events_in_window(v_from, v_to)
  ),
  call_agg AS (
    SELECT
      e.caller_id,
      e.caller_name,
      count(*)::integer AS total_calls,
      count(*) FILTER (WHERE e.is_engaged)::integer AS engaged_calls,
      count(*) FILTER (WHERE e.is_reached)::integer AS reached_calls,
      count(*) FILTER (WHERE e.is_unreachable)::integer AS unreachable_calls,
      count(*) FILTER (WHERE e.is_callback)::integer AS callback_calls,
      count(DISTINCT e.landlord_key)::integer AS unique_landlords,
      GREATEST(1, count(DISTINCT date_trunc('hour', e.called_at AT TIME ZONE 'Africa/Kampala')))::integer AS active_hours
    FROM ev e
    GROUP BY e.caller_id, e.caller_name
  ),
  -- Follow-ups owed/overdue on landlord rows (from cc_followups + callback rows + forwarded concerns)
  followup_agg AS (
    SELECT
      u_id AS staff_user_id,
      count(*)::integer AS owed_cnt,
      count(*) FILTER (WHERE due_at < now())::integer AS overdue_cnt
    FROM (
      -- 1. Open cc_followups for landlords mapped to staff user_id
      SELECT
        hs.user_id AS u_id,
        f.due_at
      FROM public.cc_followups f
      JOIN public.hr_staff hs ON hs.id = f.owed_by_staff_id
      WHERE f.subject_type = 'landlord'::cc_subject_type
        AND f.completed_at IS NULL
        AND hs.user_id IS NOT NULL

      UNION ALL

      -- 2. Open landlord concerns assigned to staff user_id
      SELECT
        c.forwarded_to AS u_id,
        c.due_at
      FROM public.cc_forwarded_concerns c
      WHERE c.status <> 'completed'
        AND c.forwarded_to IS NOT NULL
        AND (
          c.subject_type = 'landlord'
          OR EXISTS (
            SELECT 1 FROM public.cc_cycle_rows r
            WHERE r.id = c.cycle_row_id AND r.subject_type = 'landlord'::cc_subject_type
          )
        )
    ) fu
    GROUP BY u_id
  )
  SELECT
    ca.caller_id AS staff_id,
    ca.caller_name AS staff_name,
    ca.total_calls,
    ca.engaged_calls,
    ca.reached_calls,
    ca.unreachable_calls,
    ca.callback_calls,
    ca.unique_landlords,
    CASE
      WHEN ca.total_calls > 0 THEN round((ca.reached_calls::numeric * 100.0) / ca.total_calls, 1)
      ELSE 0::numeric
    END AS reach_rate_pct,
    ca.active_hours,
    CASE
      WHEN ca.active_hours > 0 THEN round(ca.total_calls::numeric / ca.active_hours, 2)
      ELSE ca.total_calls::numeric
    END AS calls_per_active_hour,
    COALESCE(fa.owed_cnt, 0)::integer AS followups_owed,
    COALESCE(fa.overdue_cnt, 0)::integer AS followups_overdue
  FROM call_agg ca
  LEFT JOIN followup_agg fa ON fa.staff_user_id = ca.caller_id
  ORDER BY ca.total_calls DESC, ca.reached_calls DESC, ca.caller_name ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.landlord_cc_staff_performance(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landlord_cc_staff_performance(date, date) TO authenticated, service_role;

-- =============================================================================
-- RPC 5: landlord_cc_landlord_call_log(p_from date, p_to date, p_limit int, p_offset int)
-- One row per call with landlord, phone (masked unless role allows), caller,
-- time, source, outcome, category, note. Paged, no 1,000/5,000 silent caps.
-- Includes `total_count` on each row so the client can paginate or fetch all pages.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.landlord_cc_landlord_call_log(
  p_from date,
  p_to date,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  call_id uuid,
  called_at timestamptz,
  kampala_day date,
  landlord_key uuid,
  landlord_name text,
  phone text,
  phone_masked boolean,
  caller_id uuid,
  caller_name text,
  source text,
  direction text,
  outcome text,
  is_reached boolean,
  category_code text,
  category_label text,
  note text,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from timestamptz;
  v_to   timestamptz;
  v_unmasked boolean;
  v_limit integer := GREATEST(1, COALESCE(p_limit, 100));
  v_offset integer := GREATEST(0, COALESCE(p_offset, 0));
BEGIN
  IF NOT (pg_trigger_depth() > 0 OR auth.uid() IS NULL OR public._landlord_cc_staff_ok()) THEN
    RAISE EXCEPTION 'Not authorized to view Landlord Calling Center call log'
      USING ERRCODE = '42501';
  END IF;

  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RETURN;
  END IF;

  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_unmasked := (pg_trigger_depth() > 0 OR auth.uid() IS NULL OR public._landlord_cc_can_view_unmasked_phone());

  RETURN QUERY
  WITH base AS MATERIALIZED (
    SELECT *
    FROM public._landlord_cc_events_in_window(v_from, v_to)
  ),
  counted AS (
    SELECT count(*)::bigint AS n FROM base
  )
  SELECT
    b.call_id,
    b.called_at,
    b.kampala_day,
    b.landlord_key,
    b.landlord_name,
    CASE
      WHEN b.raw_phone IS NULL OR btrim(b.raw_phone) = '' THEN '—'
      WHEN v_unmasked THEN b.raw_phone
      ELSE public.crm_mask_phone(b.raw_phone)
    END AS phone,
    (NOT v_unmasked) AS phone_masked,
    b.caller_id,
    b.caller_name,
    b.source,
    b.direction,
    b.outcome,
    b.is_reached,
    b.category_code,
    b.category_label,
    b.note,
    c.n AS total_count
  FROM base b
  CROSS JOIN counted c
  ORDER BY b.called_at DESC, b.call_id ASC
  LIMIT v_limit
  OFFSET v_offset;
END;
$$;

REVOKE ALL ON FUNCTION public.landlord_cc_landlord_call_log(date, date, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landlord_cc_landlord_call_log(date, date, integer, integer) TO authenticated, service_role;

-- =============================================================================
-- RPC 6: landlord_cc_concerns_report(p_from date, p_to date)
-- Landlord concerns & feedback breakdown by category, team/recipient, age, overdue.
-- Returns structured JSONB with:
--   - totals (total_concerns, open_concerns, completed_concerns, overdue_concerns, avg_resolution_hours)
--   - by_category (category_code, category_label, total_count, open_count, completed_count, overdue_count)
--   - by_team (team_name, recipient_name, total_count, open_count, completed_count, overdue_count, avg_age_hours)
--   - by_age_bucket (bucket_label, total_count, open_count, overdue_count)
--   - rows (detailed concern items with category, team, recipient, age_hours, is_overdue)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.landlord_cc_concerns_report(
  p_from date,
  p_to date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from timestamptz;
  v_to   timestamptz;
  v_result jsonb;
BEGIN
  IF NOT (pg_trigger_depth() > 0 OR auth.uid() IS NULL OR public._landlord_cc_staff_ok()) THEN
    RAISE EXCEPTION 'Not authorized to view Landlord Calling Center concerns report'
      USING ERRCODE = '42501';
  END IF;

  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RETURN jsonb_build_object(
      'totals', jsonb_build_object('total_concerns', 0, 'open_concerns', 0, 'completed_concerns', 0, 'overdue_concerns', 0, 'avg_resolution_hours', null),
      'by_category', '[]'::jsonb,
      'by_team', '[]'::jsonb,
      'by_age_bucket', '[]'::jsonb,
      'rows', '[]'::jsonb
    );
  END IF;

  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');

  WITH landlord_concerns AS MATERIALIZED (
    SELECT
      c.id AS concern_id,
      c.source_kind,
      c.title,
      c.context,
      c.priority,
      c.status,
      c.created_at,
      c.due_at,
      c.completed_at,
      c.outcome,
      COALESCE(NULLIF(btrim(c.caller_name), ''), 'Unnamed Landlord') AS landlord_name,
      COALESCE(NULLIF(btrim(c.forwarded_by_name), ''), 'Officer') AS forwarded_by_name,
      c.forwarded_to,
      COALESCE(NULLIF(btrim(c.forwarded_to_name), ''), 'Staff member') AS recipient_name,
      COALESCE(cat.code, CASE WHEN c.source_kind = 'received_call' THEN 'received_call' ELSE 'general_concern' END) AS category_code,
      COALESCE(cat.label, CASE WHEN c.source_kind = 'received_call' THEN 'Received Call Concern' ELSE 'Landlord Concern' END) AS category_label,
      COALESCE(dept.dept_name, 'Landlord Operations') AS team_name,
      round((extract(epoch FROM (COALESCE(c.completed_at, now()) - c.created_at)) / 3600.0)::numeric, 1) AS age_hours,
      (c.status <> 'completed' AND c.due_at IS NOT NULL AND c.due_at < now()) AS is_overdue
    FROM public.cc_forwarded_concerns c
    LEFT JOIN public.cc_feedback fb ON fb.id = c.feedback_id
    LEFT JOIN public.cc_feedback_categories cat ON cat.id = fb.category_id
    LEFT JOIN LATERAL (
      SELECT d.name AS dept_name
      FROM public.hr_staff hs
      JOIN public.hr_assignments ha ON ha.staff_id = hs.id AND ha.ended_on IS NULL
      JOIN public.hr_departments d ON d.id = ha.department_id
      WHERE hs.user_id = c.forwarded_to
      ORDER BY ha.is_primary DESC NULLS LAST, ha.started_on DESC NULLS LAST
      LIMIT 1
    ) dept ON true
    WHERE c.created_at >= v_from
      AND c.created_at < v_to
      AND (
        c.subject_type = 'landlord'
        OR EXISTS (
          SELECT 1 FROM public.cc_cycle_rows r
          WHERE r.id = c.cycle_row_id AND r.subject_type = 'landlord'::cc_subject_type
        )
        OR EXISTS (
          SELECT 1 FROM public.cc_received_calls rc
          WHERE rc.id = c.received_call_id AND rc.linked_kind = 'landlord'
        )
      )
  ),
  by_cat AS (
    SELECT
      lc.category_code,
      lc.category_label,
      count(*)::int AS total_count,
      count(*) FILTER (WHERE lc.status <> 'completed')::int AS open_count,
      count(*) FILTER (WHERE lc.status = 'completed')::int AS completed_count,
      count(*) FILTER (WHERE lc.is_overdue)::int AS overdue_count,
      round(avg(lc.age_hours), 1) AS avg_age_hours
    FROM landlord_concerns lc
    GROUP BY lc.category_code, lc.category_label
    ORDER BY total_count DESC, lc.category_label ASC
  ),
  by_team AS (
    SELECT
      lc.team_name,
      lc.recipient_name,
      count(*)::int AS total_count,
      count(*) FILTER (WHERE lc.status <> 'completed')::int AS open_count,
      count(*) FILTER (WHERE lc.status = 'completed')::int AS completed_count,
      count(*) FILTER (WHERE lc.is_overdue)::int AS overdue_count,
      round(avg(lc.age_hours), 1) AS avg_age_hours
    FROM landlord_concerns lc
    GROUP BY lc.team_name, lc.recipient_name
    ORDER BY total_count DESC, lc.team_name ASC, lc.recipient_name ASC
  ),
  by_age AS (
    SELECT
      b.bucket_key,
      b.bucket_label,
      b.sort_order,
      count(lc.concern_id)::int AS total_count,
      count(lc.concern_id) FILTER (WHERE lc.status <> 'completed')::int AS open_count,
      count(lc.concern_id) FILTER (WHERE lc.is_overdue)::int AS overdue_count
    FROM (
      VALUES
        ('under_24h', 'Under 24 hours', 1, 0::numeric, 24::numeric),
        ('1_to_3d',   '1 to 3 days',    2, 24::numeric, 72::numeric),
        ('3_to_7d',   '3 to 7 days',    3, 72::numeric, 168::numeric),
        ('over_7d',   'Over 7 days',    4, 168::numeric, NULL::numeric)
    ) AS b(bucket_key, bucket_label, sort_order, min_h, max_h)
    LEFT JOIN landlord_concerns lc
      ON lc.age_hours >= b.min_h
     AND (b.max_h IS NULL OR lc.age_hours < b.max_h)
    GROUP BY b.bucket_key, b.bucket_label, b.sort_order
    ORDER BY b.sort_order
  )
  SELECT jsonb_build_object(
    'totals', jsonb_build_object(
      'total_concerns', (SELECT count(*)::int FROM landlord_concerns),
      'open_concerns', (SELECT count(*) FILTER (WHERE status <> 'completed')::int FROM landlord_concerns),
      'completed_concerns', (SELECT count(*) FILTER (WHERE status = 'completed')::int FROM landlord_concerns),
      'overdue_concerns', (SELECT count(*) FILTER (WHERE is_overdue)::int FROM landlord_concerns),
      'avg_resolution_hours', (SELECT round(avg(age_hours) FILTER (WHERE status = 'completed'), 1) FROM landlord_concerns)
    ),
    'by_category', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'category_code', bc.category_code,
          'category_label', bc.category_label,
          'total_count', bc.total_count,
          'open_count', bc.open_count,
          'completed_count', bc.completed_count,
          'overdue_count', bc.overdue_count,
          'avg_age_hours', bc.avg_age_hours
        )
      )
      FROM by_cat bc
    ), '[]'::jsonb),
    'by_team', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'team_name', bt.team_name,
          'recipient_name', bt.recipient_name,
          'total_count', bt.total_count,
          'open_count', bt.open_count,
          'completed_count', bt.completed_count,
          'overdue_count', bt.overdue_count,
          'avg_age_hours', bt.avg_age_hours
        )
      )
      FROM by_team bt
    ), '[]'::jsonb),
    'by_age_bucket', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'bucket_key', ba.bucket_key,
          'bucket_label', ba.bucket_label,
          'total_count', ba.total_count,
          'open_count', ba.open_count,
          'overdue_count', ba.overdue_count
        )
        ORDER BY ba.sort_order
      )
      FROM by_age ba
    ), '[]'::jsonb),
    'rows', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'concern_id', lc.concern_id,
          'source_kind', lc.source_kind,
          'title', lc.title,
          'context', lc.context,
          'priority', lc.priority,
          'status', lc.status,
          'created_at', lc.created_at,
          'due_at', lc.due_at,
          'completed_at', lc.completed_at,
          'outcome', lc.outcome,
          'landlord_name', lc.landlord_name,
          'forwarded_by_name', lc.forwarded_by_name,
          'recipient_name', lc.recipient_name,
          'team_name', lc.team_name,
          'category_code', lc.category_code,
          'category_label', lc.category_label,
          'age_hours', lc.age_hours,
          'is_overdue', lc.is_overdue
        )
        ORDER BY lc.is_overdue DESC, lc.created_at DESC
      )
      FROM landlord_concerns lc
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.landlord_cc_concerns_report(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landlord_cc_concerns_report(date, date) TO authenticated, service_role;

-- =============================================================================
-- RPC 7: landlord_cc_round_report(p_cycle_id uuid)
-- Final reached/parked/outstanding for a landlord calling cycle (defaults to
-- the latest open or most recently opened landlord cycle if p_cycle_id IS NULL).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.landlord_cc_round_report(
  p_cycle_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cycle public.cc_call_cycles;
  v_opener_name text;
  v_result jsonb;
BEGIN
  IF NOT (pg_trigger_depth() > 0 OR auth.uid() IS NULL OR public._landlord_cc_staff_ok()) THEN
    RAISE EXCEPTION 'Not authorized to view Landlord Calling Center round report'
      USING ERRCODE = '42501';
  END IF;

  IF p_cycle_id IS NOT NULL THEN
    SELECT * INTO v_cycle
    FROM public.cc_call_cycles c
    WHERE c.id = p_cycle_id
      AND c.subject_type = 'landlord'::cc_subject_type;
  ELSE
    SELECT * INTO v_cycle
    FROM public.cc_call_cycles c
    WHERE c.subject_type = 'landlord'::cc_subject_type
    ORDER BY (c.closed_at IS NULL) DESC, c.opened_at DESC
    LIMIT 1;
  END IF;

  IF v_cycle.id IS NULL THEN
    RETURN jsonb_build_object(
      'cycle', null,
      'totals', jsonb_build_object(
        'total_rows', 0,
        'reached_count', 0,
        'engaged_count', 0,
        'callback_count', 0,
        'parked_count', 0,
        'outstanding_count', 0,
        'to_call_count', 0,
        'unreachable_count', 0,
        'closed_count', 0,
        'total_attempts', 0
      ),
      'by_state', '[]'::jsonb,
      'by_caller', '[]'::jsonb,
      'by_park_reason', '[]'::jsonb
    );
  END IF;

  SELECT COALESCE(NULLIF(btrim(p.full_name), ''), 'Staff member')
    INTO v_opener_name
  FROM public.profiles p
  WHERE p.id = v_cycle.opened_by;

  WITH rows_in_cycle AS (
    SELECT r.*
    FROM public.cc_cycle_rows r
    WHERE r.cycle_id = v_cycle.id
      AND r.subject_type = 'landlord'::cc_subject_type
  ),
  attempts_in_cycle AS (
    SELECT a.*, r.state AS row_state
    FROM public.cc_call_attempts a
    JOIN rows_in_cycle r ON r.id = a.cycle_row_id
    WHERE a.void_reason IS NULL
  ),
  by_state AS (
    SELECT
      s.st::text AS state,
      count(r.id)::int AS row_count
    FROM unnest(enum_range(NULL::cc_row_state)) AS s(st)
    LEFT JOIN rows_in_cycle r ON r.state = s.st
    GROUP BY s.st
    ORDER BY s.st
  ),
  by_caller AS (
    SELECT
      a.caller_id,
      COALESCE(NULLIF(btrim(p.full_name), ''), 'Call centre officer') AS caller_name,
      count(*)::int AS attempts_count,
      count(*) FILTER (WHERE a.outcome = 'engaged'::cc_attempt_outcome)::int AS engaged_count,
      count(*) FILTER (WHERE a.outcome = 'callback_booked'::cc_attempt_outcome)::int AS callback_count,
      count(*) FILTER (WHERE a.outcome NOT IN ('engaged'::cc_attempt_outcome, 'callback_booked'::cc_attempt_outcome))::int AS unreached_count
    FROM attempts_in_cycle a
    LEFT JOIN public.profiles p ON p.id = a.caller_id
    GROUP BY a.caller_id, p.full_name
    ORDER BY attempts_count DESC, caller_name ASC
  ),
  by_park AS (
    SELECT
      COALESCE(NULLIF(btrim(r.park_reason), ''), 'unspecified') AS park_reason,
      count(*)::int AS row_count
    FROM rows_in_cycle r
    WHERE r.state = 'parked'::cc_row_state
    GROUP BY COALESCE(NULLIF(btrim(r.park_reason), ''), 'unspecified')
    ORDER BY row_count DESC
  )
  SELECT jsonb_build_object(
    'cycle', jsonb_build_object(
      'id', v_cycle.id,
      'cycle_no', v_cycle.cycle_no,
      'title', v_cycle.title,
      'description', v_cycle.description,
      'opened_at', v_cycle.opened_at,
      'opened_by', v_cycle.opened_by,
      'opened_by_name', COALESCE(v_opener_name, 'Staff member'),
      'closed_at', v_cycle.closed_at,
      'abandoned_reason', v_cycle.abandoned_reason,
      'retry_after_days', v_cycle.retry_after_days,
      'attempt_cap', v_cycle.attempt_cap
    ),
    'totals', jsonb_build_object(
      'total_rows', (SELECT count(*)::int FROM rows_in_cycle),
      'reached_count', (SELECT count(*) FILTER (WHERE state IN ('engaged'::cc_row_state, 'callback'::cc_row_state))::int FROM rows_in_cycle),
      'engaged_count', (SELECT count(*) FILTER (WHERE state = 'engaged'::cc_row_state)::int FROM rows_in_cycle),
      'callback_count', (SELECT count(*) FILTER (WHERE state = 'callback'::cc_row_state)::int FROM rows_in_cycle),
      'parked_count', (SELECT count(*) FILTER (WHERE state = 'parked'::cc_row_state)::int FROM rows_in_cycle),
      'outstanding_count', (SELECT count(*) FILTER (WHERE state IN ('to_call'::cc_row_state, 'unreachable'::cc_row_state, 'callback'::cc_row_state))::int FROM rows_in_cycle),
      'to_call_count', (SELECT count(*) FILTER (WHERE state = 'to_call'::cc_row_state)::int FROM rows_in_cycle),
      'unreachable_count', (SELECT count(*) FILTER (WHERE state = 'unreachable'::cc_row_state)::int FROM rows_in_cycle),
      'closed_count', (SELECT count(*) FILTER (WHERE state = 'closed'::cc_row_state)::int FROM rows_in_cycle),
      'total_attempts', (SELECT count(*)::int FROM attempts_in_cycle)
    ),
    'by_state', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('state', bs.state, 'row_count', bs.row_count)
      )
      FROM by_state bs
    ), '[]'::jsonb),
    'by_caller', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'caller_id', bc.caller_id,
          'caller_name', bc.caller_name,
          'attempts_count', bc.attempts_count,
          'engaged_count', bc.engaged_count,
          'callback_count', bc.callback_count,
          'unreached_count', bc.unreached_count
        )
      )
      FROM by_caller bc
    ), '[]'::jsonb),
    'by_park_reason', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('park_reason', bp.park_reason, 'row_count', bp.row_count)
      )
      FROM by_park bp
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.landlord_cc_round_report(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landlord_cc_round_report(uuid) TO authenticated, service_role;
