-- =============================================================================
-- Migration: 20261027130000_staff_assistant_prompt3_coverage_and_learning.sql
-- Purpose:   Zoe (My Space AI Assistant) — Prompt 3 Coverage, Conversation
--            Memory, Conversation Management & Weekly CRM Learning Loop:
--              1. Conversation memory column (`conversation_summary jsonb`) on
--                 `public.staff_assistant_conversations` + checked RPCs for
--                 listing, creating, and renaming conversations.
--              2. Eleven new read-only `assistant_staff_*` coverage tools
--                 (Prompt 3 item 6, using official functions from supabase/AGENTS.md):
--                   - assistant_staff_my_calls(p_from, p_to)
--                   - assistant_staff_tops_rent_requests_by_stage(p_from, p_to)
--                   - assistant_staff_tops_time_on_desk(p_stage, p_limit)
--                   - assistant_staff_tops_find_tenant(p_search, p_limit)
--                   - assistant_staff_tops_awareness_calls(p_from, p_to)
--                   - assistant_staff_lops_verification_queue(p_limit)
--                   - assistant_staff_aops_subagent_teams(p_from, p_to, p_limit)
--                   - assistant_staff_pops_returns_due(p_from, p_to)
--                   - assistant_staff_pops_topups_and_withdrawals_waiting(p_limit)
--                   - assistant_staff_fops_disbursements(p_from, p_to)
--                   - assistant_staff_fops_merchant_cashouts(p_from, p_to)
--              3. Extend `staff_assistant_can_user_read_report` for the 11 new
--                 `assistant_staff_*` RPCs.
--              4. Weekly CRM Learning Loop (Prompt 3 item 7): extend
--                 `staff_assistant_crm_review_dashboard` and add
--                 `staff_assistant_crm_weekly_learning_report` returning both
--                 most-asked unanswered questions and thumbs-down questions
--                 (strictly redacted: question, comment, tools, outcome, roles;
--                 never assistant answer text, report_payload, or figures).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Conversation Memory (`conversation_summary`) & Conversation Rename RPC
-- -----------------------------------------------------------------------------
ALTER TABLE public.staff_assistant_conversations
  ADD COLUMN IF NOT EXISTS conversation_summary jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.staff_assistant_rename_conversation(
  p_conversation_id uuid,
  p_title text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_clean_title text := left(btrim(regexp_replace(coalesce(p_title, ''), '[\x00-\x1F\x7F]', '', 'g')), 120);
  v_row record;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'staff_assistant_not_authorized'
      USING ERRCODE = '42501';
  END IF;

  IF p_conversation_id IS NULL OR v_clean_title = '' THEN
    RAISE EXCEPTION 'conversation_id and non-empty title are required'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.staff_assistant_conversations c
     SET title = v_clean_title,
         updated_at = now()
   WHERE c.id = p_conversation_id
     AND c.user_id = v_uid
     AND c.hidden_by_user = false
  RETURNING c.id, c.title, c.last_message_at, c.message_count
    INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation not found or not owned by caller'
      USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'conversation_id', v_row.id,
    'title', v_row.title,
    'last_message_at', v_row.last_message_at,
    'message_count', v_row.message_count
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_rename_conversation(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_rename_conversation(uuid, text) TO authenticated, service_role;

-- =============================================================================
-- 2. ELEVEN NEW READ-ONLY `assistant_staff_*` COVERAGE TOOLS (Prompt 3 item 6)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- C1. My Own Calls This Week / Period (`assistant_staff_my_calls`)
--     Uses `staff_calling_detailed_report` + `cc_weekly_all_calls_report`
--     filtered to `auth.uid()` (plus the caller's own `cc_call_attempts` and
--     `rent_pipeline_awareness_calls` rows).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_my_calls(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_to date := LEAST(coalesce(p_to, v_today), v_today);
  v_from date := LEAST(coalesce(p_from, v_to - 6), v_to);
  v_start timestamptz := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_end timestamptz := ((v_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_detailed jsonb := '[]'::jsonb;
  v_weekly_summary jsonb := '[]'::jsonb;
  v_total_calls integer := 0;
  v_answered_calls integer := 0;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required.'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    SELECT coalesce(
      jsonb_agg(
        public.staff_assistant_sanitize_jsonb(
          to_jsonb(r) - 'staff_id' - 'rr_id' - 'person_id',
          true,
          200
        )
      ),
      '[]'::jsonb
    )
    INTO v_detailed
    FROM (
      SELECT *
        FROM public.staff_calling_detailed_report(v_start, v_end) sdr
       WHERE sdr.staff_id = v_uid
       LIMIT 200
    ) r;
  EXCEPTION
    WHEN OTHERS THEN
      v_detailed := '[]'::jsonb;
  END;

  BEGIN
    SELECT coalesce(
      jsonb_agg(to_jsonb(w) - 'caller_id'),
      '[]'::jsonb
    )
    INTO v_weekly_summary
    FROM (
      SELECT *
        FROM public.cc_weekly_all_calls_report(v_start, v_end) cwr
       WHERE cwr.caller_id = v_uid
       LIMIT 200
    ) w;
  EXCEPTION
    WHEN OTHERS THEN
      v_weekly_summary := '[]'::jsonb;
  END;

  IF jsonb_array_length(v_detailed) = 0 THEN
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object(
          'day', (coalesce(a.recorded_at, a.created_at) AT TIME ZONE 'Africa/Kampala')::date,
          'source', 'Calling Center',
          'outcome', a.outcome::text,
          'answered', (a.outcome::text = 'engaged'),
          'channel', a.channel::text
        )
      ),
      '[]'::jsonb
    )
    INTO v_detailed
    FROM (
      SELECT a.recorded_at, a.created_at, a.outcome, a.channel
        FROM public.cc_call_attempts a
       WHERE a.caller_id = v_uid
         AND a.void_reason IS NULL
         AND a.outcome IS NOT NULL
         AND coalesce(a.recorded_at, a.created_at) >= v_start
         AND coalesce(a.recorded_at, a.created_at) < v_end
       ORDER BY coalesce(a.recorded_at, a.created_at) DESC
       LIMIT 200
    ) a;
  END IF;

  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE (elem ->> 'answered') = 'true')::integer
  INTO v_total_calls, v_answered_calls
  FROM jsonb_array_elements(v_detailed) elem;

  RETURN jsonb_build_object(
    'source', 'staff_calling_detailed_report + cc_weekly_all_calls_report (My Space Own Calls)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'total_calls', coalesce(v_total_calls, 0),
    'answered_calls', coalesce(v_answered_calls, 0),
    'row_count', jsonb_array_length(v_detailed),
    'rows', v_detailed,
    'weekly_summary', v_weekly_summary
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_my_calls(date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_my_calls(date, date) TO authenticated;

-- -----------------------------------------------------------------------------
-- C2. Tenant Ops: Rent Requests Today and by Stage
--     (`assistant_staff_tops_rent_requests_by_stage`)
--     Uses `ops_tenant_ops_home_range` + `tenant_ops_rent_request_lifetime` +
--     live stage counts on `rent_requests`.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_tops_rent_requests_by_stage(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_to date := LEAST(coalesce(p_to, v_today), v_today);
  v_from date := LEAST(coalesce(p_from, v_to), v_to);
  v_start timestamptz := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_end timestamptz := ((v_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_home jsonb := '{}'::jsonb;
  v_lifetime jsonb := '{}'::jsonb;
  v_stages jsonb := '[]'::jsonb;
  v_arrived_in_range integer := 0;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT (
       public.is_ops_role(v_uid)
       OR public._has_enabled_role(
         v_uid,
         ARRAY['tenant_ops', 'operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
       )
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Tenant Ops Rent Plan request stage reports.'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_home := public.ops_tenant_ops_home_range(v_start, v_end);
  EXCEPTION
    WHEN OTHERS THEN
      v_home := '{}'::jsonb;
  END;

  BEGIN
    v_lifetime := public.tenant_ops_rent_request_lifetime();
  EXCEPTION
    WHEN OTHERS THEN
      v_lifetime := '{}'::jsonb;
  END;

  SELECT count(*)::integer
    INTO v_arrived_in_range
    FROM public.rent_requests rr
   WHERE rr.created_at >= v_start
     AND rr.created_at < v_end
     AND rr.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent');

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'stage', s.status,
        'request_count', s.cnt,
        'total_rent_ugx', s.rent_sum,
        'arrived_in_period', s.arrived_cnt
      )
      ORDER BY s.stage_ord, s.status
    ),
    '[]'::jsonb
  )
  INTO v_stages
  FROM (
    SELECT
      rr.status::text AS status,
      CASE rr.status::text
        WHEN 'service_center_review' THEN 1
        WHEN 'pending' THEN 2
        WHEN 'agent_ops_approved' THEN 3
        WHEN 'agent_verified' THEN 4
        WHEN 'tenant_ops_approved' THEN 5
        WHEN 'landlord_ops_approved' THEN 6
        WHEN 'partner_ops_approved' THEN 7
        WHEN 'coo_approved' THEN 8
        WHEN 'cfo_approved' THEN 9
        WHEN 'funded' THEN 10
        WHEN 'repaying' THEN 11
        WHEN 'completed' THEN 12
        ELSE 99
      END AS stage_ord,
      count(*)::integer AS cnt,
      coalesce(sum(rr.rent_amount), 0)::numeric AS rent_sum,
      count(*) FILTER (WHERE rr.created_at >= v_start AND rr.created_at < v_end)::integer AS arrived_cnt
    FROM public.rent_requests rr
    WHERE rr.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent')
    GROUP BY rr.status::text
  ) s;

  RETURN jsonb_build_object(
    'source', 'ops_tenant_ops_home_range + tenant_ops_rent_request_lifetime (Rent Plan Requests Today & By Stage)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'arrived_in_period_count', coalesce(v_arrived_in_range, 0),
    'home_range_summary', coalesce(v_home, '{}'::jsonb),
    'lifetime_funnel', coalesce(v_lifetime, '{}'::jsonb),
    'row_count', jsonb_array_length(v_stages),
    'rows', v_stages
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_tops_rent_requests_by_stage(date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_tops_rent_requests_by_stage(date, date) TO authenticated;

-- -----------------------------------------------------------------------------
-- C3. Tenant Ops: Time on Desk & Longest Waiting Applications
--     (`assistant_staff_tops_time_on_desk`)
--     Uses `public.rent_request_timing(p_request_ids)` (`supabase/AGENTS.md` line 27).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_tops_time_on_desk(
  p_stage text DEFAULT NULL,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 50), 1), 200);
  v_stage text := nullif(lower(btrim(coalesce(p_stage, ''))), '');
  v_allow_phones boolean;
  v_ids uuid[];
  v_timing jsonb := '{}'::jsonb;
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT (
       public.is_ops_role(v_uid)
       OR public._has_enabled_role(
         v_uid,
         ARRAY['tenant_ops', 'agent_ops', 'landlord_ops', 'partner_ops', 'operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
       )
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Rent Plan desk timing reports.'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('tenant_ops');

  SELECT coalesce(array_agg(q.id), ARRAY[]::uuid[])
    INTO v_ids
    FROM (
      SELECT rr.id
        FROM public.rent_requests rr
       WHERE rr.status IN (
         'service_center_review',
         'pending',
         'agent_ops_approved',
         'agent_verified',
         'tenant_ops_approved',
         'landlord_ops_approved',
         'partner_ops_approved',
         'coo_approved'
       )
         AND (v_stage IS NULL OR lower(rr.status::text) = v_stage)
       ORDER BY rr.created_at ASC
       LIMIT v_limit
    ) q;

  IF cardinality(v_ids) > 0 THEN
    v_timing := public.rent_request_timing(v_ids);

    SELECT coalesce(
      jsonb_agg(
        public.staff_assistant_sanitize_jsonb(
          jsonb_build_object(
            'tenant_name', coalesce(tp.full_name, 'Unnamed tenant'),
            'tenant_phone', tp.phone,
            'status', rr.status,
            'rent_amount_ugx', rr.rent_amount,
            'created_at', rr.created_at,
            'desk', tr.val -> 'current_desk' ->> 'desk',
            'current_desk_seconds', (tr.val -> 'current_desk' ->> 'elapsed_seconds')::bigint,
            'current_desk_hours', round(coalesce((tr.val -> 'current_desk' ->> 'elapsed_seconds')::numeric, 0) / 3600.0, 1),
            'total_elapsed_hours', round(coalesce((tr.val -> 'total' ->> 'elapsed_seconds')::numeric, 0) / 3600.0, 1),
            'quality', tr.val -> 'current_desk' ->> 'quality'
          ),
          v_allow_phones,
          200
        )
        ORDER BY coalesce((tr.val -> 'current_desk' ->> 'elapsed_seconds')::bigint, 0) DESC
      ),
      '[]'::jsonb
    )
    INTO v_rows
    FROM jsonb_array_elements(coalesce(v_timing -> 'rows', '[]'::jsonb)) AS tr(val)
    JOIN public.rent_requests rr ON rr.id = (tr.val ->> 'request_id')::uuid
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id;
  END IF;

  RETURN jsonb_build_object(
    'source', 'rent_request_timing (Rent Plan Time on Desk)',
    'period', jsonb_build_object(
      'as_of', v_today,
      'stage_filter', coalesce(v_stage, 'all_open_desks'),
      'timezone', 'Africa/Kampala'
    ),
    'row_count', jsonb_array_length(v_rows),
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_tops_time_on_desk(text, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_tops_time_on_desk(text, integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- C4. Tenant Ops: Find a Tenant (`assistant_staff_tops_find_tenant`)
--     Uses `tops_tenant_classification_list` + `tenant_payment_score`
--     (`supabase/AGENTS.md` lines 12–13).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_tops_find_tenant(
  p_search text,
  p_limit integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 25), 1), 100);
  v_allow_phones boolean;
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT public._am_staff_ok()
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['tenant_ops', 'operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Tenant Ops tenant search.'
      USING ERRCODE = '42501';
  END IF;

  IF v_search IS NULL OR length(v_search) < 2 THEN
    RAISE EXCEPTION 'Provide at least 2 characters in p_search to find a tenant.'
      USING ERRCODE = '22023';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('tenant_ops');

  WITH matched AS (
    SELECT *
      FROM public.tops_tenant_classification_list(NULL, NULL, v_search, v_limit, 0, false)
     LIMIT v_limit
  ),
  scores AS (
    SELECT s.*
      FROM public.tenant_payment_score(
        ARRAY(SELECT m.tenant_id FROM matched m WHERE m.tenant_id IS NOT NULL)
      ) s
  )
  SELECT coalesce(
    jsonb_agg(
      public.staff_assistant_sanitize_jsonb(
        (to_jsonb(m) - 'tenant_id') || jsonb_build_object(
          'payment_score', sc.score,
          'payment_label', sc.label,
          'payment_reason', sc.reason
        ),
        v_allow_phones,
        200
      )
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM matched m
  LEFT JOIN scores sc ON sc.tenant_id = m.tenant_id;

  RETURN jsonb_build_object(
    'source', 'tops_tenant_classification_list + tenant_payment_score (Find a Tenant)',
    'period', jsonb_build_object(
      'as_of', v_today,
      'search', v_search,
      'timezone', 'Africa/Kampala'
    ),
    'row_count', jsonb_array_length(v_rows),
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_tops_find_tenant(text, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_tops_find_tenant(text, integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- C5. Tenant Ops & Landlord Ops: Rent Plan Awareness Calls
--     (`assistant_staff_tops_awareness_calls`)
--     Uses `cc_weekly_all_calls_report` (`source = 'awareness'`) +
--     `rent_pipeline_awareness_calls` (`supabase/AGENTS.md` line 32).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_tops_awareness_calls(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_to date := LEAST(coalesce(p_to, v_today), v_today);
  v_from date := LEAST(coalesce(p_from, v_to - 6), v_to);
  v_start timestamptz := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_end timestamptz := ((v_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_allow_phones boolean;
  v_summary jsonb := '[]'::jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_total_calls integer := 0;
  v_answered_calls integer := 0;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['tenant_ops', 'landlord_ops', 'operations', 'hr', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Rent Plan pipeline awareness call reports.'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('tenant_ops');

  BEGIN
    SELECT coalesce(
      jsonb_agg(to_jsonb(w) - 'caller_id'),
      '[]'::jsonb
    )
    INTO v_summary
    FROM (
      SELECT *
        FROM public.cc_weekly_all_calls_report(v_start, v_end) cwr
       WHERE cwr.source IN ('awareness', 'pipeline_landlord')
       LIMIT 200
    ) w;
  EXCEPTION
    WHEN OTHERS THEN
      v_summary := '[]'::jsonb;
  END;

  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE w.call_result = 'answered')::integer
  INTO v_total_calls, v_answered_calls
  FROM public.rent_pipeline_awareness_calls w
  WHERE coalesce(w.recorded_at, w.dial_started_at) >= v_start
    AND coalesce(w.recorded_at, w.dial_started_at) < v_end;

  SELECT coalesce(
    jsonb_agg(
      public.staff_assistant_sanitize_jsonb(
        jsonb_build_object(
          'recorded_at', coalesce(w.recorded_at, w.dial_started_at),
          'caller_name', coalesce(cp.full_name, 'Staff Caller'),
          'subject_type', w.subject_type,
          'subject_phone', w.subject_phone,
          'call_result', w.call_result,
          'pipeline_stage', w.pipeline_stage,
          'landlord_consent', w.landlord_consent,
          'aware_payout_otp', w.aware_payout_otp
        ),
        v_allow_phones,
        200
      )
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM (
    SELECT *
      FROM public.rent_pipeline_awareness_calls w
     WHERE coalesce(w.recorded_at, w.dial_started_at) >= v_start
       AND coalesce(w.recorded_at, w.dial_started_at) < v_end
     ORDER BY coalesce(w.recorded_at, w.dial_started_at) DESC
     LIMIT 200
  ) w
  LEFT JOIN public.profiles cp ON cp.id = w.caller_id;

  RETURN jsonb_build_object(
    'source', 'cc_weekly_all_calls_report + rent_pipeline_awareness_calls (Rent Plan Awareness Calls)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'total_awareness_calls', coalesce(v_total_calls, 0),
    'answered_awareness_calls', coalesce(v_answered_calls, 0),
    'weekly_summary', v_summary,
    'row_count', jsonb_array_length(v_rows),
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_tops_awareness_calls(date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_tops_awareness_calls(date, date) TO authenticated;

-- -----------------------------------------------------------------------------
-- C6. Landlord Ops: Landlord Verification Queue
--     (`assistant_staff_lops_verification_queue`)
--     Uses `ops_landlord_ops_home_range` + `v_landlord_ops_status` (`supabase/AGENTS.md` line 20).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_lops_verification_queue(
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_start timestamptz := (v_today::timestamp AT TIME ZONE 'Africa/Kampala');
  v_end timestamptz := ((v_today + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 50), 1), 200);
  v_allow_phones boolean;
  v_home jsonb := '{}'::jsonb;
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['landlord_ops', 'coo', 'cfo', 'ceo', 'manager', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Landlord Ops verification queue.'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('landlord_ops');
  v_home := public.ops_landlord_ops_home_range(v_start, v_end);

  SELECT coalesce(
    jsonb_agg(
      public.staff_assistant_sanitize_jsonb(
        jsonb_build_object(
          'landlord_name', coalesce(l.name, 'Unnamed landlord'),
          'phone', l.phone,
          'verification_status', v.status,
          'service_center_status', l.service_center_status,
          'has_tenant', v.has_tenant,
          'created_at', l.created_at
        ),
        v_allow_phones,
        200
      )
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM (
    SELECT l.id, l.name, l.phone, l.service_center_status, l.created_at, v.status, v.has_tenant
      FROM public.landlords l
      JOIN public.v_landlord_ops_status v ON v.landlord_id = l.id
     WHERE coalesce(l.service_center_status, '') <> 'pending'
       AND (l.verified IS NULL OR l.verified = false)
     ORDER BY l.created_at DESC
     LIMIT v_limit
  ) l
  JOIN public.v_landlord_ops_status v ON v.landlord_id = l.id;

  RETURN jsonb_build_object(
    'source', 'ops_landlord_ops_home_range + v_landlord_ops_status (Landlord Ops Verification Queue)',
    'period', jsonb_build_object(
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'pending_verification_counts', coalesce(v_home -> 'pending_verification', '{}'::jsonb),
    'row_count', jsonb_array_length(v_rows),
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_lops_verification_queue(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_lops_verification_queue(integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- C7. Agent Ops: Sub-Agent Teams (`assistant_staff_aops_subagent_teams`)
--     Uses `agent_ops_metrics_main_agents` + `agent_ops_metrics_risk`
--     (`supabase/AGENTS.md` lines 23–24).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_aops_subagent_teams(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_to date := LEAST(coalesce(p_to, v_today), v_today);
  v_from date := LEAST(coalesce(p_from, v_to - 29), v_to);
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 50), 1), 200);
  v_allow_phones boolean;
  v_rows jsonb := '[]'::jsonb;
  v_risk jsonb := '{}'::jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT public.agent_ops_report_authorized()
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['agent_ops', 'operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Agent Ops sub-agent team reports.'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('agent_ops');

  SELECT coalesce(
    jsonb_agg(
      public.staff_assistant_sanitize_jsonb(
        to_jsonb(r) - 'main_agent_id',
        v_allow_phones,
        200
      )
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM (
    SELECT *
      FROM public.agent_ops_metrics_main_agents(v_from, v_to, v_limit, 0)
     LIMIT v_limit
  ) r;

  v_risk := public.agent_ops_metrics_risk(v_from, v_to, LEAST(v_limit, 50), 0);

  RETURN jsonb_build_object(
    'source', 'agent_ops_metrics_main_agents + agent_ops_metrics_risk (Agent Ops Sub-Agent Teams)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'row_count', jsonb_array_length(v_rows),
    'rows', v_rows,
    'team_risk_summary', public.staff_assistant_sanitize_jsonb(
      coalesce(v_risk, '{}'::jsonb),
      v_allow_phones,
      200
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_aops_subagent_teams(date, date, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_aops_subagent_teams(date, date, integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- C8. Partner Ops & Finance: Supporter Returns Due This Week / Period
--     (`assistant_staff_pops_returns_due`)
--     Uses `get_payables_predictive_forecast` + `partner_ops_report_totals` +
--     `partner_ops_report_breakdown` (`supabase/AGENTS.md` line 31).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_pops_returns_due(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_to date := coalesce(p_to, v_today + 6);
  v_from date := LEAST(coalesce(p_from, v_today), v_to);
  v_start timestamptz := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_end timestamptz := ((v_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_allow_phones boolean;
  v_totals jsonb := '{}'::jsonb;
  v_breakdown jsonb := '{}'::jsonb;
  v_forecast jsonb := '{}'::jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT (
       public.can_view_staff_reports(v_uid)
       OR public.can_view_finance_reports(v_uid)
     )
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['partner_ops', 'financial_ops', 'cfo', 'ceo', 'coo', 'manager', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Supporter Returns due reports.'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('partner_ops');

  BEGIN
    v_totals := public.partner_ops_report_totals();
    v_breakdown := public.partner_ops_report_breakdown(v_start, v_end);
  EXCEPTION
    WHEN OTHERS THEN
      v_totals := '{}'::jsonb;
      v_breakdown := '{}'::jsonb;
  END;

  BEGIN
    v_forecast := public.get_payables_predictive_forecast('week', 4, v_today);
  EXCEPTION
    WHEN OTHERS THEN
      v_forecast := '{}'::jsonb;
  END;

  RETURN jsonb_build_object(
    'source', 'partner_ops_report_totals + partner_ops_report_breakdown + get_payables_predictive_forecast (Supporter Returns Due)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'totals', coalesce(v_totals, '{}'::jsonb),
    'breakdown', public.staff_assistant_sanitize_jsonb(
      coalesce(v_breakdown, '{}'::jsonb),
      v_allow_phones,
      200
    ),
    'payables_weekly_forecast', coalesce(v_forecast, '{}'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_pops_returns_due(date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_pops_returns_due(date, date) TO authenticated;

-- -----------------------------------------------------------------------------
-- C9. Partner Ops & Finance: Top-Ups and Withdrawals Waiting
--     (`assistant_staff_pops_topups_and_withdrawals_waiting`)
--     Uses `partner_ops_pending_portfolio_summary` + waiting rows in
--     `pending_wallet_operations` and `withdrawal_requests`.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_pops_topups_and_withdrawals_waiting(
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 50), 1), 200);
  v_allow_phones boolean;
  v_pending_portfolios jsonb := '{}'::jsonb;
  v_waiting_topups_count integer := 0;
  v_waiting_topups_ugx numeric := 0;
  v_waiting_withdrawals_count integer := 0;
  v_waiting_withdrawals_ugx numeric := 0;
  v_withdrawal_rows jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT (
       public.can_view_staff_reports(v_uid)
       OR public.can_view_finance_reports(v_uid)
     )
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['partner_ops', 'financial_ops', 'cfo', 'ceo', 'coo', 'manager', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for waiting top-ups and withdrawals reports.'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('partner_ops');

  BEGIN
    SELECT to_jsonb(r)
      INTO v_pending_portfolios
      FROM public.partner_ops_pending_portfolio_summary() r
     LIMIT 1;
  EXCEPTION
    WHEN OTHERS THEN
      v_pending_portfolios := '{}'::jsonb;
  END;

  SELECT
    count(*)::integer,
    coalesce(sum(pwo.amount), 0)::numeric
  INTO v_waiting_topups_count, v_waiting_topups_ugx
  FROM public.pending_wallet_operations pwo
  WHERE pwo.status IN ('pending', 'waiting', 'awaiting_approval', 'partner_ops_approved', 'coo_approved')
    AND pwo.direction = 'cash_in';

  SELECT
    count(*)::integer,
    coalesce(sum(wr.amount), 0)::numeric
  INTO v_waiting_withdrawals_count, v_waiting_withdrawals_ugx
  FROM public.withdrawal_requests wr
  WHERE wr.status IN ('pending', 'approved', 'cfo_approved', 'finops_verified', 'processing');

  SELECT coalesce(
    jsonb_agg(
      public.staff_assistant_sanitize_jsonb(
        jsonb_build_object(
          'requester_name', coalesce(p.full_name, 'Account Holder'),
          'phone', p.phone,
          'amount_ugx', wr.amount,
          'status', wr.status,
          'requested_at', wr.created_at
        ),
        v_allow_phones,
        200
      )
    ),
    '[]'::jsonb
  )
  INTO v_withdrawal_rows
  FROM (
    SELECT wr.user_id, wr.amount, wr.status, wr.created_at
      FROM public.withdrawal_requests wr
     WHERE wr.status IN ('pending', 'approved', 'cfo_approved', 'finops_verified', 'processing')
     ORDER BY wr.created_at ASC
     LIMIT v_limit
  ) wr
  LEFT JOIN public.profiles p ON p.id = wr.user_id;

  RETURN jsonb_build_object(
    'source', 'partner_ops_pending_portfolio_summary + pending_wallet_operations + withdrawal_requests (Top-Ups & Withdrawals Waiting)',
    'period', jsonb_build_object(
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'pending_portfolios', coalesce(v_pending_portfolios, '{}'::jsonb),
    'waiting_topups_count', coalesce(v_waiting_topups_count, 0),
    'waiting_topups_total_ugx', coalesce(v_waiting_topups_ugx, 0),
    'waiting_withdrawals_count', coalesce(v_waiting_withdrawals_count, 0),
    'waiting_withdrawals_total_ugx', coalesce(v_waiting_withdrawals_ugx, 0),
    'row_count', jsonb_array_length(v_withdrawal_rows),
    'rows', v_withdrawal_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_pops_topups_and_withdrawals_waiting(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_pops_topups_and_withdrawals_waiting(integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- C10. CFO & Financial Ops: Disbursements (`assistant_staff_fops_disbursements`)
--      Uses `cfo_approved_requisitions` + `landlord_payouts` disbursed summary.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_fops_disbursements(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_to date := LEAST(coalesce(p_to, v_today), v_today);
  v_from date := LEAST(coalesce(p_from, v_to - 6), v_to);
  v_start timestamptz := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_end timestamptz := ((v_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_allow_phones boolean;
  v_payout_count integer := 0;
  v_payout_total_ugx numeric := 0;
  v_payout_rows jsonb := '[]'::jsonb;
  v_requisitions jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_finance_reports(v_uid)
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['financial_ops', 'cfo', 'ceo', 'coo', 'manager', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Financial Ops disbursement reports.'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('finance');

  SELECT
    count(*)::integer,
    coalesce(sum(lp.amount), 0)::numeric
  INTO v_payout_count, v_payout_total_ugx
  FROM public.landlord_payouts lp
  WHERE lp.status <> 'failed'
    AND coalesce(lp.finops_disbursed_at, lp.disbursed_at) >= v_start
    AND coalesce(lp.finops_disbursed_at, lp.disbursed_at) < v_end;

  SELECT coalesce(
    jsonb_agg(
      public.staff_assistant_sanitize_jsonb(
        jsonb_build_object(
          'landlord_name', coalesce(l.name, 'Landlord'),
          'phone', coalesce(lp.payout_number, l.phone),
          'amount_ugx', lp.amount,
          'status', lp.status,
          'disbursed_at', coalesce(lp.finops_disbursed_at, lp.disbursed_at)
        ),
        v_allow_phones,
        200
      )
    ),
    '[]'::jsonb
  )
  INTO v_payout_rows
  FROM (
    SELECT lp.landlord_id, lp.amount, lp.status, lp.payout_number, lp.finops_disbursed_at, lp.disbursed_at
      FROM public.landlord_payouts lp
     WHERE lp.status <> 'failed'
       AND coalesce(lp.finops_disbursed_at, lp.disbursed_at) >= v_start
       AND coalesce(lp.finops_disbursed_at, lp.disbursed_at) < v_end
     ORDER BY coalesce(lp.finops_disbursed_at, lp.disbursed_at) DESC
     LIMIT 100
  ) lp
  LEFT JOIN public.landlords l ON l.id = lp.landlord_id;

  SELECT coalesce(
    jsonb_agg(to_jsonb(r) - 'requisition_id' - 'receiver_id'),
    '[]'::jsonb
  )
  INTO v_requisitions
  FROM (
    SELECT *
      FROM public.cfo_approved_requisitions(v_start, v_end)
     LIMIT 100
  ) r;

  RETURN jsonb_build_object(
    'source', 'landlord_payouts + cfo_approved_requisitions (Disbursements Report)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'landlord_payouts_count', coalesce(v_payout_count, 0),
    'landlord_payouts_total_ugx', coalesce(v_payout_total_ugx, 0),
    'requisition_disbursements_count', jsonb_array_length(v_requisitions),
    'requisition_disbursements', v_requisitions,
    'row_count', jsonb_array_length(v_payout_rows),
    'rows', v_payout_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_fops_disbursements(date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_fops_disbursements(date, date) TO authenticated;

-- -----------------------------------------------------------------------------
-- C11. CFO & Financial Ops: Merchant Cash-Outs & Wallet Withdrawals
--      (`assistant_staff_fops_merchant_cashouts`)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_fops_merchant_cashouts(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_to date := LEAST(coalesce(p_to, v_today), v_today);
  v_from date := LEAST(coalesce(p_from, v_to - 6), v_to);
  v_start timestamptz := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_end timestamptz := ((v_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_allow_phones boolean;
  v_completed_count integer := 0;
  v_completed_ugx numeric := 0;
  v_pending_count integer := 0;
  v_pending_ugx numeric := 0;
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.staff_assistant_has_access()
     OR NOT public.can_view_finance_reports(v_uid)
     OR NOT public._has_enabled_role(
       v_uid,
       ARRAY['financial_ops', 'cfo', 'ceo', 'coo', 'manager', 'super_admin']
     )
  THEN
    RAISE EXCEPTION 'Not authorized for merchant cash-out and withdrawal reports.'
      USING ERRCODE = '42501';
  END IF;

  v_allow_phones := public.staff_assistant_can_view_pii('finance');

  SELECT
    count(*) FILTER (WHERE wr.status IN ('completed', 'approved', 'disbursed'))::integer,
    coalesce(sum(wr.amount) FILTER (WHERE wr.status IN ('completed', 'approved', 'disbursed')), 0)::numeric,
    count(*) FILTER (WHERE wr.status IN ('pending', 'cfo_approved', 'finops_verified', 'processing'))::integer,
    coalesce(sum(wr.amount) FILTER (WHERE wr.status IN ('pending', 'cfo_approved', 'finops_verified', 'processing')), 0)::numeric
  INTO v_completed_count, v_completed_ugx, v_pending_count, v_pending_ugx
  FROM public.withdrawal_requests wr
  WHERE wr.created_at >= v_start
    AND wr.created_at < v_end;

  SELECT coalesce(
    jsonb_agg(
      public.staff_assistant_sanitize_jsonb(
        jsonb_build_object(
          'account_name', coalesce(p.full_name, 'Account Holder'),
          'phone', p.phone,
          'amount_ugx', wr.amount,
          'status', wr.status,
          'created_at', wr.created_at
        ),
        v_allow_phones,
        200
      )
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM (
    SELECT wr.user_id, wr.amount, wr.status, wr.created_at
      FROM public.withdrawal_requests wr
     WHERE wr.created_at >= v_start
       AND wr.created_at < v_end
     ORDER BY wr.created_at DESC
     LIMIT 200
  ) wr
  LEFT JOIN public.profiles p ON p.id = wr.user_id;

  RETURN jsonb_build_object(
    'source', 'withdrawal_requests (Merchant Cash-Outs & Wallet Withdrawals)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'completed_cashouts_count', coalesce(v_completed_count, 0),
    'completed_cashouts_total_ugx', coalesce(v_completed_ugx, 0),
    'pending_cashouts_count', coalesce(v_pending_count, 0),
    'pending_cashouts_total_ugx', coalesce(v_pending_ugx, 0),
    'row_count', jsonb_array_length(v_rows),
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_fops_merchant_cashouts(date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_fops_merchant_cashouts(date, date) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Update `staff_assistant_can_user_read_report` to include the 11 new RPCs
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_can_user_read_report(
  p_user_id uuid,
  p_report_rpc text,
  p_owner_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller_role text := COALESCE(auth.role(), '');
  v_caller_uid uuid := (SELECT auth.uid());
  v_rpc text := lower(btrim(COALESCE(p_report_rpc, '')));
  v_roles text[];
BEGIN
  IF v_caller_role <> 'service_role' THEN
    IF v_caller_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
      RETURN false;
    END IF;
  END IF;

  IF p_user_id IS NULL OR v_rpc !~ '^assistant_staff_[a-z0-9_]+$' THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.staff_assistant_config c
    WHERE c.id = true AND c.enabled = true
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = p_user_id
      AND COALESCE(p.is_frozen, false) IS TRUE
  ) THEN
    RETURN false;
  END IF;

  SELECT COALESCE(
    array_agg(DISTINCT lower(ur.role::text)) FILTER (WHERE ur.enabled IS TRUE),
    ARRAY[]::text[]
  )
    INTO v_roles
    FROM public.user_roles ur
   WHERE ur.user_id = p_user_id
     AND ur.enabled IS TRUE;

  IF NOT (
    v_roles && public.staff_assistant_write_or_read_roles_list()
    OR EXISTS (
      SELECT 1
      FROM public.hr_staff hs
      WHERE hs.user_id = p_user_id
        AND hs.active IS TRUE
        AND hs.ended_on IS NULL
    )
  ) THEN
    RETURN false;
  END IF;

  IF v_rpc LIKE 'assistant_staff_my_%' THEN
    RETURN (p_owner_id IS NULL OR p_user_id = p_owner_id);
  END IF;

  IF v_rpc IN (
    'assistant_staff_tops_first_seven_summary',
    'assistant_staff_tops_tenant_classification',
    'assistant_staff_tops_smartphone_usage',
    'assistant_staff_tops_no_payment_report',
    'assistant_staff_tops_rent_requests_by_stage',
    'assistant_staff_tops_time_on_desk',
    'assistant_staff_tops_find_tenant'
  ) THEN
    RETURN v_roles && ARRAY['tenant_ops','operations','coo','ceo','cfo','cto','manager','super_admin'];
  END IF;

  IF v_rpc = 'assistant_staff_tops_awareness_calls' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['tenant_ops','landlord_ops','operations','hr','coo','ceo','cfo','cto','manager','super_admin']);
  END IF;

  IF v_rpc IN (
    'assistant_staff_tops_arrears_ageing',
    'assistant_staff_tops_landlord_not_paid'
  ) THEN
    RETURN v_roles && ARRAY['tenant_ops','operations','coo','ceo','cfo','super_admin'];
  END IF;

  IF v_rpc IN (
    'assistant_staff_tops_weekly_performance',
    'assistant_staff_tops_rent_request_lifetime',
    'assistant_staff_tops_pipeline_waiting_on_lops'
  ) THEN
    RETURN v_roles && ARRAY['tenant_ops','operations','coo','ceo','cto','manager','super_admin'];
  END IF;

  IF v_rpc IN ('assistant_staff_lops_home_range', 'assistant_staff_lops_verification_queue') THEN
    RETURN v_roles && ARRAY['landlord_ops','coo','cfo','ceo','manager','super_admin'];
  END IF;

  IF v_rpc = 'assistant_staff_lops_paid_lists' THEN
    RETURN v_roles && ARRAY['landlord_ops','coo','cfo','ceo','super_admin'];
  END IF;

  IF v_rpc = 'assistant_staff_lops_principal_comparison' THEN
    RETURN v_roles && ARRAY['landlord_ops','cfo','ceo','coo','manager','financial_ops','super_admin','cto'];
  END IF;

  IF v_rpc IN (
    'assistant_staff_lops_calling_summary',
    'assistant_staff_lops_calling_coverage'
  ) THEN
    RETURN v_roles && ARRAY['landlord_ops','operations','coo','ceo','cfo','cto','manager','hr','super_admin'];
  END IF;

  IF v_rpc = 'assistant_staff_aops_network_overview' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['operations','coo','ceo','cfo','cto','manager','super_admin']);
  END IF;

  IF v_rpc IN (
    'assistant_staff_aops_metrics_totals',
    'assistant_staff_aops_metrics_agents',
    'assistant_staff_aops_listing_quality_and_risk',
    'assistant_staff_aops_subagent_teams'
  ) THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['agent_ops','operations','coo','ceo','cfo','cto','manager','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_aops_silent_collectors' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['agent_ops','tenant_ops','operations','coo','ceo','cfo','cto','manager','super_admin']);
  END IF;

  IF v_rpc IN (
    'assistant_staff_pops_pending_summary',
    'assistant_staff_pops_search_supporters'
  ) THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['partner_ops','cfo','ceo','coo','manager','super_admin']);
  END IF;

  IF v_rpc IN (
    'assistant_staff_pops_report_overview',
    'assistant_staff_pops_returns_due',
    'assistant_staff_pops_topups_and_withdrawals_waiting'
  ) THEN
    RETURN (public.can_view_staff_reports(p_user_id) OR public.can_view_finance_reports(p_user_id))
       AND (v_roles && ARRAY['partner_ops','financial_ops','cfo','ceo','coo','manager','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_pso_cohort_performance' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['partner_ops','hr','coo','ceo','super_admin']);
  END IF;

  IF v_rpc IN (
    'assistant_staff_cfo_treasury_cash_position',
    'assistant_staff_cfo_receivables_and_payables',
    'assistant_staff_cfo_seven_day_expenses'
  ) THEN
    RETURN public.can_view_finance_reports(p_user_id)
       AND (v_roles && ARRAY['cfo','ceo','coo','manager','financial_ops','cto','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_cfo_money_flow_summary' THEN
    RETURN public.can_view_finance_reports(p_user_id)
       AND (v_roles && ARRAY['cfo','ceo','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_cfo_budget_revised_position' THEN
    RETURN public.can_view_finance_reports(p_user_id)
       AND (v_roles && ARRAY['cfo','ceo','coo','super_admin']);
  END IF;

  IF v_rpc IN (
    'assistant_staff_fops_verification_and_requisitions',
    'assistant_staff_fops_disbursements',
    'assistant_staff_fops_merchant_cashouts'
  ) THEN
    RETURN public.can_view_finance_reports(p_user_id)
       AND (v_roles && ARRAY['financial_ops','cfo','ceo','coo','manager','super_admin']);
  END IF;

  IF v_rpc IN (
    'assistant_staff_coo_overview',
    'assistant_staff_ceo_growth_and_approvals'
  ) THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['coo','ceo','cfo','manager','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_hr_calling_detailed_report' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (
         p_user_id IN (
           '5295252d-f477-42a9-92f5-af56e503e33d'::uuid,
           'a9258d45-3e27-4827-af71-64344e76fb4f'::uuid,
           'fda0d518-98c4-45e4-83d8-64266b25eefa'::uuid,
           'fe1e9f51-a2c3-49fc-bd40-b2c143afe628'::uuid
         )
         OR (v_roles && ARRAY['hr','tenant_ops','landlord_ops','operations','coo','cfo','ceo','manager','super_admin'])
       );
  END IF;

  IF v_rpc = 'assistant_staff_hr_contracts_and_birthdays' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['hr','coo','ceo','cfo','super_admin']);
  END IF;

  IF v_rpc = 'assistant_staff_hr_payroll_cost_by_department' THEN
    RETURN public.can_view_staff_reports(p_user_id)
       AND (v_roles && ARRAY['hr','cfo','coo','ceo','super_admin']);
  END IF;

  RETURN false;
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_can_user_read_report(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_can_user_read_report(uuid, text, uuid) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. Weekly CRM Learning Loop (Prompt 3 item 7):
--    Lists the most-asked unanswered questions AND thumbs-down questions
--    for the CRM review screen, strictly redacted (never returning answer text,
--    report_payload, or figures).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_crm_weekly_learning_report(
  p_days integer DEFAULT 7,
  p_role_filter text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_days integer := LEAST(GREATEST(coalesce(p_days, 7), 1), 90);
  v_role_filter text := nullif(lower(btrim(coalesce(p_role_filter, ''))), '');
  v_today_kampala date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_week_start timestamptz := ((v_today_kampala - (v_days - 1))::timestamp AT TIME ZONE 'Africa/Kampala');
  v_unanswered jsonb := '[]'::jsonb;
  v_thumbs_down jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_crm_can_review() THEN
    RAISE EXCEPTION 'staff_assistant_crm_not_authorized'
      USING ERRCODE = '42501';
  END IF;

  -- A. Most-asked unanswered questions over the window
  WITH staff_roles_by_user AS (
    SELECT
      ur.user_id,
      array_agg(DISTINCT ur.role::text ORDER BY ur.role::text) AS roles
    FROM public.user_roles ur
    WHERE ur.enabled = true
    GROUP BY ur.user_id
  ),
  unans_raw AS (
    SELECT
      u.id,
      u.user_id,
      lower(regexp_replace(btrim(u.question), '\s+', ' ', 'g')) AS norm_question,
      btrim(u.question) AS display_question,
      u.reason,
      u.status,
      u.review_note,
      u.created_at,
      coalesce(sr.roles, ARRAY['employee']::text[]) AS caller_roles
    FROM public.staff_assistant_unanswered u
    LEFT JOIN staff_roles_by_user sr ON sr.user_id = u.user_id
    WHERE u.created_at >= v_week_start
      AND (v_role_filter IS NULL OR v_role_filter = ANY(coalesce(sr.roles, ARRAY['employee']::text[])))
  ),
  grouped_unans AS (
    SELECT
      ur.norm_question AS normalized_question,
      (ARRAY_AGG(ur.display_question ORDER BY ur.created_at DESC))[1] AS question_text,
      count(*)::int AS ask_count,
      count(DISTINCT ur.user_id)::int AS unique_staff_count,
      (ARRAY_AGG(ur.reason ORDER BY ur.created_at DESC))[1] AS latest_reason,
      (ARRAY_AGG(ur.status ORDER BY ur.created_at DESC))[1] AS latest_status,
      (ARRAY_AGG(ur.id ORDER BY ur.created_at DESC))[1] AS latest_id,
      (ARRAY_AGG(ur.review_note ORDER BY ur.created_at DESC))[1] AS latest_review_note,
      min(ur.created_at) AS first_seen_at,
      max(ur.created_at) AS last_seen_at,
      ARRAY(
        SELECT DISTINCT r_role
        FROM unans_raw u2,
             unnest(u2.caller_roles) AS r_role
        WHERE u2.norm_question = ur.norm_question
        ORDER BY r_role
      ) AS roles_asking
    FROM unans_raw ur
    WHERE ur.norm_question <> ''
    GROUP BY ur.norm_question
    ORDER BY count(*) DESC, max(ur.created_at) DESC
    LIMIT 25
  )
  SELECT coalesce(jsonb_agg(row_to_json(g)::jsonb), '[]'::jsonb)
    INTO v_unanswered
    FROM grouped_unans g;

  -- B. Weekly thumbs-down answers (REDACTED: user question, feedback comment, tools_called,
  --    outcome, source_label, caller roles — NEVER assistant answer text or report_payload)
  WITH staff_roles_by_user AS (
    SELECT
      ur.user_id,
      array_agg(DISTINCT ur.role::text ORDER BY ur.role::text) AS roles
    FROM public.user_roles ur
    WHERE ur.enabled = true
    GROUP BY ur.user_id
  ),
  down_rows AS (
    SELECT
      f.id AS feedback_id,
      f.conversation_id,
      f.message_id,
      f.user_id,
      f.comment AS feedback_comment,
      f.created_at,
      coalesce(sr.roles, ARRAY['employee']::text[]) AS caller_roles,
      am.outcome,
      coalesce(am.tools_called, ARRAY[]::text[]) AS tools_called,
      am.source_label,
      am.period_label,
      (
        SELECT um.content
        FROM public.staff_assistant_messages um
        WHERE um.conversation_id = f.conversation_id
          AND um.role = 'user'
          AND um.created_at <= coalesce(am.created_at, f.created_at)
        ORDER BY um.created_at DESC
        LIMIT 1
      ) AS user_question
    FROM public.staff_assistant_feedback f
    LEFT JOIN public.staff_assistant_messages am ON am.id = f.message_id
    LEFT JOIN staff_roles_by_user sr ON sr.user_id = f.user_id
    WHERE f.rating = 'down'
      AND f.created_at >= v_week_start
      AND (v_role_filter IS NULL OR v_role_filter = ANY(coalesce(sr.roles, ARRAY['employee']::text[])))
  ),
  grouped_down AS (
    SELECT
      lower(regexp_replace(btrim(coalesce(dr.user_question, 'Unknown question')), '\s+', ' ', 'g')) AS normalized_question,
      (ARRAY_AGG(coalesce(dr.user_question, 'Unknown question') ORDER BY dr.created_at DESC))[1] AS question_text,
      count(*)::int AS thumbs_down_count,
      count(DISTINCT dr.user_id)::int AS unique_staff_count,
      (ARRAY_AGG(dr.feedback_comment ORDER BY dr.created_at DESC) FILTER (WHERE dr.feedback_comment IS NOT NULL AND btrim(dr.feedback_comment) <> ''))[1] AS latest_comment,
      (ARRAY_AGG(dr.outcome ORDER BY dr.created_at DESC))[1] AS latest_outcome,
      (ARRAY_AGG(dr.source_label ORDER BY dr.created_at DESC) FILTER (WHERE dr.source_label IS NOT NULL))[1] AS latest_source_label,
      (ARRAY_AGG(dr.tools_called ORDER BY dr.created_at DESC))[1] AS tools_called,
      (ARRAY_AGG(dr.conversation_id ORDER BY dr.created_at DESC))[1] AS latest_conversation_id,
      max(dr.created_at) AS last_feedback_at,
      ARRAY(
        SELECT DISTINCT r_role
        FROM down_rows d2,
             unnest(d2.caller_roles) AS r_role
        WHERE lower(regexp_replace(btrim(coalesce(d2.user_question, 'Unknown question')), '\s+', ' ', 'g')) =
              lower(regexp_replace(btrim(coalesce(dr.user_question, 'Unknown question')), '\s+', ' ', 'g'))
        ORDER BY r_role
      ) AS roles_reporting,
      true AS answer_redacted
    FROM down_rows dr
    GROUP BY lower(regexp_replace(btrim(coalesce(dr.user_question, 'Unknown question')), '\s+', ' ', 'g'))
    ORDER BY count(*) DESC, max(dr.created_at) DESC
    LIMIT 25
  )
  SELECT coalesce(jsonb_agg(row_to_json(gd)::jsonb), '[]'::jsonb)
    INTO v_thumbs_down
    FROM grouped_down gd;

  RETURN jsonb_build_object(
    'source', 'staff_assistant_crm_weekly_learning_report',
    'period', jsonb_build_object(
      'days', v_days,
      'from', (v_week_start AT TIME ZONE 'Africa/Kampala')::date,
      'to', v_today_kampala,
      'timezone', 'Africa/Kampala'
    ),
    'weekly_unanswered_summary', v_unanswered,
    'weekly_thumbs_down_summary', v_thumbs_down
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_crm_weekly_learning_report(integer, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_crm_weekly_learning_report(integer, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. Update `staff_assistant_crm_review_dashboard` to include
--    `weekly_thumbs_down_summary` from `staff_assistant_crm_weekly_learning_report`
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_crm_review_dashboard(
  p_role_filter     text    DEFAULT NULL,
  p_thumbs_down     boolean DEFAULT false,
  p_unanswered_only boolean DEFAULT false,
  p_search          text    DEFAULT NULL,
  p_days            integer DEFAULT 14,
  p_limit           integer DEFAULT 80
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid           uuid := (SELECT auth.uid());
  v_days          integer := LEAST(GREATEST(COALESCE(p_days, 14), 1), 90);
  v_limit         integer := LEAST(GREATEST(COALESCE(p_limit, 80), 1), 200);
  v_role_filter   text := NULLIF(lower(btrim(COALESCE(p_role_filter, ''))), '');
  v_search        text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_search_esc    text;
  v_now_kampala   timestamp := (now() AT TIME ZONE 'Africa/Kampala');
  v_today_kampala date := v_now_kampala::date;
  v_today_start   timestamptz := (v_today_kampala::timestamp AT TIME ZONE 'Africa/Kampala');
  v_since         timestamptz := ((v_today_kampala - (v_days - 1))::timestamp AT TIME ZONE 'Africa/Kampala');
  v_week_start    timestamptz := ((v_today_kampala - 6)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_cfg           record;
  v_conversations jsonb;
  v_weekly_unans  jsonb;
  v_weekly_down   jsonb := '[]'::jsonb;
  v_learning      jsonb := '{}'::jsonb;
  v_daily_usage   jsonb;
  v_role_options  jsonb;
  v_totals        jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_crm_can_review() THEN
    RAISE EXCEPTION 'staff_assistant_crm_not_authorized'
      USING ERRCODE = '42501';
  END IF;

  IF v_search IS NOT NULL THEN
    v_search_esc := regexp_replace(v_search, '([\\_%])', '\\\1', 'g');
  END IF;

  SELECT
    COALESCE(c.enabled, true)              AS enabled,
    COALESCE(c.max_questions_per_day, 80)  AS max_questions_per_day,
    COALESCE(c.max_emails_per_day, 30)     AS max_emails_per_day,
    c.updated_at                           AS updated_at
  INTO v_cfg
  FROM public.staff_assistant_config c
  WHERE c.id = true;

  IF NOT FOUND THEN
    v_cfg := ROW(true, 80, 30, now());
  END IF;

  WITH staff_roles_by_user AS (
    SELECT
      ur.user_id,
      array_agg(DISTINCT ur.role::text ORDER BY ur.role::text) AS roles
    FROM public.user_roles ur
    WHERE ur.enabled = true
    GROUP BY ur.user_id
  ),
  conv_stats AS (
    SELECT
      m.conversation_id,
      count(*) FILTER (WHERE m.role = 'user')::int AS question_count,
      count(*) FILTER (WHERE m.role = 'assistant')::int AS answer_count,
      count(*) FILTER (
        WHERE m.role = 'assistant'
          AND m.outcome IN ('unmatched', 'out_of_scope', 'role_restricted', 'mfa_required', 'error', 'rate_limited', 'daily_limit')
      )::int AS could_not_answer_count,
      (
        ARRAY_AGG(m.content ORDER BY m.created_at DESC)
        FILTER (WHERE m.role = 'user')
      )[1] AS last_user_question,
      (
        ARRAY_AGG(m.outcome ORDER BY m.created_at DESC)
        FILTER (WHERE m.role = 'assistant')
      )[1] AS last_outcome,
      (
        ARRAY_AGG(m.source_label ORDER BY m.created_at DESC)
        FILTER (WHERE m.role = 'assistant' AND m.source_label IS NOT NULL)
      )[1] AS last_source_label,
      (
        ARRAY_AGG(m.period_label ORDER BY m.created_at DESC)
        FILTER (WHERE m.role = 'assistant' AND m.period_label IS NOT NULL)
      )[1] AS last_period_label,
      COALESCE(
        ARRAY(
          SELECT DISTINCT tool_name
          FROM public.staff_assistant_messages m2,
               unnest(COALESCE(m2.tools_called, ARRAY[]::text[])) AS tool_name
          WHERE m2.conversation_id = m.conversation_id
          ORDER BY tool_name
        ),
        ARRAY[]::text[]
      ) AS tools_called
    FROM public.staff_assistant_messages m
    WHERE m.created_at >= v_since
    GROUP BY m.conversation_id
  ),
  fb_stats AS (
    SELECT
      f.conversation_id,
      count(*) FILTER (WHERE f.rating = 'up')::int   AS thumbs_up_count,
      count(*) FILTER (WHERE f.rating = 'down')::int AS thumbs_down_count,
      (
        ARRAY_AGG(f.comment ORDER BY f.created_at DESC)
        FILTER (WHERE f.rating = 'down' AND f.comment IS NOT NULL AND btrim(f.comment) <> '')
      )[1] AS latest_down_comment
    FROM public.staff_assistant_feedback f
    GROUP BY f.conversation_id
  ),
  unans_conv AS (
    SELECT
      u.conversation_id,
      count(*)::int AS unanswered_logs_count,
      (ARRAY_AGG(u.reason ORDER BY u.created_at DESC))[1] AS latest_unanswered_reason
    FROM public.staff_assistant_unanswered u
    WHERE u.conversation_id IS NOT NULL
    GROUP BY u.conversation_id
  ),
  enriched AS (
    SELECT
      c.id AS conversation_id,
      c.user_id,
      COALESCE(NULLIF(btrim(p.full_name), ''), 'Staff Member') AS staff_name,
      COALESCE(NULLIF(btrim(p.email), ''), '')                 AS staff_email,
      COALESCE(sr.roles, ARRAY['employee']::text[])            AS roles,
      COALESCE(NULLIF(btrim(c.title), ''), COALESCE(cs.last_user_question, 'Zoe Conversation')) AS title,
      c.created_at,
      c.last_message_at,
      COALESCE(cs.question_count, 0)         AS question_count,
      COALESCE(cs.answer_count, 0)           AS answer_count,
      COALESCE(cs.could_not_answer_count, 0) AS could_not_answer_count,
      COALESCE(uc.unanswered_logs_count, 0)  AS unanswered_logs_count,
      (COALESCE(cs.could_not_answer_count, 0) > 0 OR COALESCE(uc.unanswered_logs_count, 0) > 0) AS has_unanswered,
      cs.last_user_question,
      cs.last_outcome,
      cs.last_source_label,
      cs.last_period_label,
      COALESCE(cs.tools_called, ARRAY[]::text[]) AS tools_called,
      COALESCE(fb.thumbs_up_count, 0)        AS thumbs_up_count,
      COALESCE(fb.thumbs_down_count, 0)      AS thumbs_down_count,
      fb.latest_down_comment,
      uc.latest_unanswered_reason
    FROM public.staff_assistant_conversations c
    LEFT JOIN public.profiles p        ON p.id = c.user_id
    LEFT JOIN staff_roles_by_user sr   ON sr.user_id = c.user_id
    LEFT JOIN conv_stats cs            ON cs.conversation_id = c.id
    LEFT JOIN fb_stats fb              ON fb.conversation_id = c.id
    LEFT JOIN unans_conv uc            ON uc.conversation_id = c.id
    WHERE c.last_message_at >= v_since
  )
  SELECT COALESCE(jsonb_agg(row_to_json(e)::jsonb ORDER BY e.last_message_at DESC), '[]'::jsonb)
  INTO v_conversations
  FROM (
    SELECT *
    FROM enriched e
    WHERE (v_role_filter IS NULL OR v_role_filter = ANY(e.roles))
      AND (NOT COALESCE(p_thumbs_down, false) OR e.thumbs_down_count > 0)
      AND (NOT COALESCE(p_unanswered_only, false) OR e.has_unanswered = true)
      AND (
        v_search_esc IS NULL
        OR e.staff_name ILIKE '%' || v_search_esc || '%' ESCAPE '\'
        OR e.staff_email ILIKE '%' || v_search_esc || '%' ESCAPE '\'
        OR e.title ILIKE '%' || v_search_esc || '%' ESCAPE '\'
        OR COALESCE(e.last_user_question, '') ILIKE '%' || v_search_esc || '%' ESCAPE '\'
      )
    ORDER BY e.last_message_at DESC
    LIMIT v_limit
  ) e;

  -- Weekly learning loop (most-asked unanswered + redacted thumbs-down answers)
  v_learning := public.staff_assistant_crm_weekly_learning_report(7, v_role_filter);
  WITH staff_roles_by_user AS (
    SELECT
      ur.user_id,
      array_agg(DISTINCT ur.role::text ORDER BY ur.role::text) AS roles
    FROM public.user_roles ur
    WHERE ur.enabled = true
    GROUP BY ur.user_id
  ),
  unans_raw AS (
    SELECT
      u.id,
      u.user_id,
      lower(regexp_replace(btrim(u.question), '\s+', ' ', 'g')) AS norm_question,
      btrim(u.question) AS display_question,
      u.reason,
      u.status,
      u.created_at,
      COALESCE(sr.roles, ARRAY['employee']::text[]) AS caller_roles
    FROM public.staff_assistant_unanswered u
    LEFT JOIN staff_roles_by_user sr ON sr.user_id = u.user_id
    WHERE u.created_at >= v_week_start
      AND (v_role_filter IS NULL OR v_role_filter = ANY(COALESCE(sr.roles, ARRAY['employee']::text[])))
  ),
  grouped_unans AS (
    SELECT
      ur.norm_question,
      (ARRAY_AGG(ur.display_question ORDER BY ur.created_at DESC))[1] AS question,
      count(*)::int AS ask_count,
      count(DISTINCT ur.user_id)::int AS staff_count,
      (ARRAY_AGG(ur.reason ORDER BY ur.created_at DESC))[1] AS top_reason,
      (ARRAY_AGG(ur.status ORDER BY ur.created_at DESC))[1] AS latest_status,
      max(ur.created_at) AS last_asked_at,
      ARRAY(
        SELECT DISTINCT r_role
        FROM unans_raw u2,
             unnest(u2.caller_roles) AS r_role
        WHERE u2.norm_question = ur.norm_question
        ORDER BY r_role
      ) AS roles_asking
    FROM unans_raw ur
    WHERE ur.norm_question <> ''
    GROUP BY ur.norm_question
    ORDER BY count(*) DESC, max(ur.created_at) DESC
    LIMIT 15
  )
  SELECT COALESCE(jsonb_agg(row_to_json(g)::jsonb), '[]'::jsonb)
  INTO v_weekly_unans
  FROM grouped_unans g;

  v_weekly_down := COALESCE(v_learning -> 'weekly_thumbs_down_summary', '[]'::jsonb);

  WITH staff_roles_by_user AS (
    SELECT
      ur.user_id,
      array_agg(DISTINCT ur.role::text ORDER BY ur.role::text) AS roles
    FROM public.user_roles ur
    WHERE ur.enabled = true
    GROUP BY ur.user_id
  ),
  questions_today AS (
    SELECT
      m.user_id,
      count(*) FILTER (WHERE m.role = 'user')::int AS questions_today,
      count(*) FILTER (WHERE m.role = 'assistant' AND m.outcome = 'answered')::int AS answered_today,
      count(*) FILTER (
        WHERE m.role = 'assistant'
          AND m.outcome IN ('unmatched', 'out_of_scope', 'role_restricted', 'mfa_required', 'error', 'rate_limited', 'daily_limit')
      )::int AS unanswered_today,
      max(m.created_at) AS last_active_at
    FROM public.staff_assistant_messages m
    WHERE m.created_at >= v_today_start
    GROUP BY m.user_id
  ),
  emails_today AS (
    SELECT
      al.user_id,
      COALESCE(
        sum(
          GREATEST(
            CASE
              WHEN (al.metadata ->> 'recipient_count') ~ '^[0-9]+$'
                THEN (al.metadata ->> 'recipient_count')::integer
              ELSE 1
            END,
            1
          )
        ),
        0
      )::int AS emails_sent_today
    FROM public.audit_logs al
    WHERE al.action_type IN ('staff_assistant_report_email_sent', 'staff_assistant_schedule_email_sent')
      AND al.created_at >= v_today_start
      AND al.user_id IS NOT NULL
    GROUP BY al.user_id
  ),
  active_people AS (
    SELECT user_id FROM questions_today
    UNION
    SELECT user_id FROM emails_today
  ),
  usage_rows AS (
    SELECT
      ap.user_id,
      COALESCE(NULLIF(btrim(p.full_name), ''), 'Staff Member') AS staff_name,
      COALESCE(NULLIF(btrim(p.email), ''), '')                 AS staff_email,
      COALESCE(sr.roles, ARRAY['employee']::text[])            AS roles,
      COALESCE(qt.questions_today, 0)                          AS questions_today,
      v_cfg.max_questions_per_day                              AS question_budget,
      GREATEST(v_cfg.max_questions_per_day - COALESCE(qt.questions_today, 0), 0) AS questions_remaining,
      ROUND(
        (COALESCE(qt.questions_today, 0)::numeric / GREATEST(v_cfg.max_questions_per_day, 1)::numeric) * 100,
        1
      )                                                        AS question_budget_pct,
      COALESCE(qt.answered_today, 0)                           AS answered_today,
      COALESCE(qt.unanswered_today, 0)                         AS unanswered_today,
      COALESCE(et.emails_sent_today, 0)                        AS emails_sent_today,
      v_cfg.max_emails_per_day                                 AS email_budget,
      GREATEST(v_cfg.max_emails_per_day - COALESCE(et.emails_sent_today, 0), 0) AS emails_remaining,
      qt.last_active_at
    FROM active_people ap
    LEFT JOIN public.profiles p       ON p.id = ap.user_id
    LEFT JOIN staff_roles_by_user sr  ON sr.user_id = ap.user_id
    LEFT JOIN questions_today qt      ON qt.user_id = ap.user_id
    LEFT JOIN emails_today et         ON et.user_id = ap.user_id
    WHERE (v_role_filter IS NULL OR v_role_filter = ANY(COALESCE(sr.roles, ARRAY['employee']::text[])))
    ORDER BY COALESCE(qt.questions_today, 0) DESC, COALESCE(et.emails_sent_today, 0) DESC, staff_name ASC
    LIMIT 100
  )
  SELECT COALESCE(jsonb_agg(row_to_json(u)::jsonb), '[]'::jsonb)
  INTO v_daily_usage
  FROM usage_rows u;

  SELECT COALESCE(jsonb_agg(r_name ORDER BY r_name), '[]'::jsonb)
  INTO v_role_options
  FROM (
    SELECT DISTINCT ur.role::text AS r_name
    FROM public.user_roles ur
    JOIN public.staff_assistant_conversations c ON c.user_id = ur.user_id
    WHERE ur.enabled = true
  ) sub;

  SELECT jsonb_build_object(
    'total_conversations', (
      SELECT count(*)::int
      FROM public.staff_assistant_conversations c
      WHERE c.last_message_at >= v_since
    ),
    'thumbs_down_conversations', (
      SELECT count(DISTINCT f.conversation_id)::int
      FROM public.staff_assistant_feedback f
      WHERE f.rating = 'down'
        AND f.created_at >= v_since
    ),
    'unanswered_questions_7d', (
      SELECT count(*)::int
      FROM public.staff_assistant_unanswered u
      WHERE u.created_at >= v_week_start
    ),
    'active_staff_today', jsonb_array_length(v_daily_usage)
  )
  INTO v_totals;

  RETURN jsonb_build_object(
    'source', 'staff_assistant_crm_review_dashboard',
    'period', jsonb_build_object(
      'days', v_days,
      'since', (v_since AT TIME ZONE 'Africa/Kampala')::date,
      'today_kampala', v_today_kampala,
      'weekly_summary_from', (v_week_start AT TIME ZONE 'Africa/Kampala')::date,
      'weekly_summary_to', v_today_kampala
    ),
    'config', jsonb_build_object(
      'enabled', v_cfg.enabled,
      'max_questions_per_day', v_cfg.max_questions_per_day,
      'max_emails_per_day', v_cfg.max_emails_per_day,
      'updated_at', v_cfg.updated_at
    ),
    'totals', v_totals,
    'available_roles', v_role_options,
    'conversations', v_conversations,
    'weekly_unanswered_summary', v_weekly_unans,
    'weekly_thumbs_down_summary', v_weekly_down,
    'daily_usage', v_daily_usage
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_crm_review_dashboard(text, boolean, boolean, text, integer, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_crm_review_dashboard(text, boolean, boolean, text, integer, integer) TO authenticated;

COMMIT;
