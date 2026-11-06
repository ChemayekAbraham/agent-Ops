-- =============================================================================
-- Migration: 20261029180000_staff_assistant_prompt4_consultant_and_proactive.sql
-- Purpose:   Zoe Brilliant Assistant Proposal — Prompt 4
--            ("Consultant mode, proactive help and real-world testing"):
--              1. Extend `public.staff_assistant_config` with admin-switched
--                 `web_research_enabled boolean NOT NULL DEFAULT false` (default off;
--                 only enabled in Consultant mode when true).
--              2. Extend `public.staff_assistant_feedback` with `report_kind`
--                 (`'rating'` or `'problem_report'`) so staff can click Thumbs Up,
--                 Thumbs Down, or "Report a problem" directly in chat and feed into
--                 the weekly manager review list.
--              3. Fix `public.assistant_staff_insight_zoe_feedback_themes` to read
--                 `u.question_text` and include `problem_report` feedback counts.
--              4. Create `public.staff_assistant_weekly_unanswered_list(p_days integer)`
--                 (`STABLE SECURITY DEFINER SET search_path = public`, granted to
--                 `authenticated` only, role-gated to managers, COO, CEO, CFO, CTO,
--                 CRM, HR, and super_admin) returning the weekly redacted
--                 "Questions Zoe could not answer" list (`question`, `role`, `outcome`
--                 only — never another person's answer text or figures).
--              5. Upgrade `public.staff_assistant_weekly_look_at_summary(p_as_of date)`
--                 so the Monday "What to look at this week" manager card includes:
--                   - Top 5 operational & quality issues with screen links
--                   - Weekly redacted "Questions Zoe could not answer" list
--                     (`question`, `role`, `outcome`, `ask_count`)
--                   - Weekly feedback summary (`thumbs_up_count`, `thumbs_down_count`,
--                     `problem_reports_count`)
--                   - Notable 4-week anomaly notes from `staff_assistant_insights`
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Admin-switched Web Research toggle on `public.staff_assistant_config`
--    Default: `false` (off). Used only in the Consultant path when enabled.
-- -----------------------------------------------------------------------------
ALTER TABLE public.staff_assistant_config
  ADD COLUMN IF NOT EXISTS web_research_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.staff_assistant_config.web_research_enabled IS
  'Admin-switched toggle (default false). When true, Zoe Consultant mode may call generic search_web and read_web_page tools (never including Welile names, phones, or figures).';

UPDATE public.staff_assistant_config
   SET web_research_enabled = COALESCE(web_research_enabled, false),
       updated_at           = now()
 WHERE id = true;

-- -----------------------------------------------------------------------------
-- 2. Extend `public.staff_assistant_feedback` with `report_kind`
--    Supports Thumbs Up ('up' + 'rating'), Thumbs Down ('down' + 'rating'),
--    and "Report a problem" ('down' + 'problem_report').
-- -----------------------------------------------------------------------------
ALTER TABLE public.staff_assistant_feedback
  ADD COLUMN IF NOT EXISTS report_kind text NOT NULL DEFAULT 'rating'
    CONSTRAINT staff_assistant_feedback_report_kind_chk
    CHECK (report_kind IN ('rating', 'problem_report'));

COMMENT ON COLUMN public.staff_assistant_feedback.report_kind IS
  'Distinguishes a standard thumbs up/down rating (rating) from an explicit Report a problem submission (problem_report).';

CREATE INDEX IF NOT EXISTS idx_staff_assistant_feedback_kind_created
  ON public.staff_assistant_feedback (report_kind, rating, created_at DESC);

-- -----------------------------------------------------------------------------
-- 3. Update `public.assistant_staff_insight_zoe_feedback_themes`
--    Uses `u.question_text` on `public.staff_assistant_unanswered` and includes
--    `problem_reports_count` from `public.staff_assistant_feedback`.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_insight_zoe_feedback_themes(
  p_days integer DEFAULT 28
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
  v_days integer := LEAST(GREATEST(coalesce(p_days, 28), 1), 90);
  v_from date := v_today - (v_days - 1);
  v_start timestamptz := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_unanswered_by_reason jsonb := '[]'::jsonb;
  v_top_unanswered jsonb := '[]'::jsonb;
  v_thumbs_down_themes jsonb := '[]'::jsonb;
  v_total_unanswered integer := 0;
  v_total_thumbs_down integer := 0;
  v_total_problem_reports integer := 0;
  v_anomalies jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT public.can_view_staff_reports(v_uid)
     OR NOT (
       public.staff_assistant_crm_can_review()
       OR public._has_enabled_role(
         v_uid,
         ARRAY['crm', 'cto', 'coo', 'ceo', 'cfo', 'hr', 'manager', 'super_admin']
       )
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Zoe unanswered question and thumbs-down theme insights.'
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::integer
    INTO v_total_unanswered
    FROM public.staff_assistant_unanswered u
   WHERE u.created_at >= v_start;

  SELECT
    count(*) FILTER (WHERE f.rating = 'down')::integer,
    count(*) FILTER (WHERE f.report_kind = 'problem_report')::integer
    INTO v_total_thumbs_down, v_total_problem_reports
    FROM public.staff_assistant_feedback f
   WHERE f.created_at >= v_start;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'reason', r.reason,
        'question_count', r.cnt,
        'open_count', r.open_cnt
      )
      ORDER BY r.cnt DESC
    ),
    '[]'::jsonb
  )
  INTO v_unanswered_by_reason
  FROM (
    SELECT
      coalesce(u.reason, 'unmatched') AS reason,
      count(*)::integer AS cnt,
      count(*) FILTER (WHERE u.status = 'open')::integer AS open_cnt
    FROM public.staff_assistant_unanswered u
    WHERE u.created_at >= v_start
    GROUP BY coalesce(u.reason, 'unmatched')
    ORDER BY count(*) DESC
  ) r;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'question_theme', g.question_text,
        'role', g.primary_role,
        'outcome', g.top_reason,
        'ask_count', g.ask_count,
        'unique_staff_count', g.unique_staff_count,
        'reason', g.top_reason,
        'status', g.latest_status
      )
      ORDER BY g.ask_count DESC
    ),
    '[]'::jsonb
  )
  INTO v_top_unanswered
  FROM (
    SELECT
      lower(regexp_replace(btrim(coalesce(u.question_text, '')), '\s+', ' ', 'g')) AS norm_q,
      (ARRAY_AGG(btrim(u.question_text) ORDER BY u.created_at DESC))[1] AS question_text,
      coalesce((ARRAY_AGG(coalesce(u.caller_roles[1], 'staff') ORDER BY u.created_at DESC))[1], 'staff') AS primary_role,
      count(*)::integer AS ask_count,
      count(DISTINCT u.user_id)::integer AS unique_staff_count,
      (ARRAY_AGG(u.reason ORDER BY u.created_at DESC))[1] AS top_reason,
      (ARRAY_AGG(u.status ORDER BY u.created_at DESC))[1] AS latest_status
    FROM public.staff_assistant_unanswered u
    WHERE u.created_at >= v_start
      AND btrim(coalesce(u.question_text, '')) <> ''
    GROUP BY lower(regexp_replace(btrim(coalesce(u.question_text, '')), '\s+', ' ', 'g'))
    ORDER BY count(*) DESC, max(u.created_at) DESC
    LIMIT 20
  ) g;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'tool_or_outcome', td.theme_key,
        'thumbs_down_count', td.down_cnt,
        'problem_reports_count', td.prob_cnt,
        'sample_comment', td.latest_comment
      )
      ORDER BY td.down_cnt DESC
    ),
    '[]'::jsonb
  )
  INTO v_thumbs_down_themes
  FROM (
    SELECT
      coalesce(
        nullif(array_to_string(am.tools_called, ', '), ''),
        coalesce(am.outcome, 'general_answer')
      ) AS theme_key,
      count(*)::integer AS down_cnt,
      count(*) FILTER (WHERE f.report_kind = 'problem_report')::integer AS prob_cnt,
      (
        ARRAY_AGG(f.comment ORDER BY f.created_at DESC)
        FILTER (WHERE f.comment IS NOT NULL AND btrim(f.comment) <> '')
      )[1] AS latest_comment
    FROM public.staff_assistant_feedback f
    LEFT JOIN public.v_staff_assistant_crm_messages_redacted am ON am.id = f.message_id
    WHERE f.rating = 'down'
      AND f.created_at >= v_start
    GROUP BY coalesce(
      nullif(array_to_string(am.tools_called, ', '), ''),
      coalesce(am.outcome, 'general_answer')
    )
    ORDER BY count(*) DESC
    LIMIT 20
  ) td;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'title', i.title,
        'summary', i.summary,
        'metric_name', i.metric_name,
        'current_value', i.current_value,
        'four_week_avg', i.four_week_avg,
        'pct_change', i.pct_change,
        'direction', i.direction,
        'source_function', i.source_function,
        'period_label', i.period_label,
        'screen_path', i.screen_path
      )
      ORDER BY i.kampala_date DESC, abs(i.pct_change) DESC
    ),
    '[]'::jsonb
  )
  INTO v_anomalies
  FROM (
    SELECT *
      FROM public.staff_assistant_insights i
     WHERE i.category = 'zoe_feedback'
       AND i.kampala_date >= v_today - 7
       AND i.is_notable = true
     ORDER BY i.kampala_date DESC, abs(i.pct_change) DESC
     LIMIT 10
  ) i;

  RETURN jsonb_build_object(
    'source', 'staff_assistant_unanswered + staff_assistant_feedback + v_staff_assistant_crm_messages_redacted (Zoe Unanswered & Thumbs-Down Themes)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_today,
      'days', v_days,
      'as_of', v_today,
      'timezone', 'Africa/Kampala'
    ),
    'total_unanswered_count', coalesce(v_total_unanswered, 0),
    'total_thumbs_down_count', coalesce(v_total_thumbs_down, 0),
    'total_problem_reports_count', coalesce(v_total_problem_reports, 0),
    'unanswered_by_reason', v_unanswered_by_reason,
    'top_unanswered_questions', v_top_unanswered,
    'thumbs_down_themes', v_thumbs_down_themes,
    'anomaly_notes', v_anomalies,
    'screen_path', '/crm/dashboard',
    'row_count', jsonb_array_length(v_top_unanswered),
    'rows', v_top_unanswered
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_insight_zoe_feedback_themes(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_insight_zoe_feedback_themes(integer) TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. Weekly "Questions Zoe could not answer" Redacted Manager List
--    (`public.staff_assistant_weekly_unanswered_list`)
--    Prompt 4 item (4):
--      "Add a weekly 'Questions Zoe could not answer' list for managers
--       (redacted: question, role, outcome only)."
--    Never returns another person's answer text, figures, or report_payload.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_weekly_unanswered_list(
  p_days integer DEFAULT 7
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_days integer := LEAST(GREATEST(coalesce(p_days, 7), 1), 90);
  v_from date := v_today - (v_days - 1);
  v_start timestamptz := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_rows jsonb := '[]'::jsonb;
  v_up_cnt integer := 0;
  v_down_cnt integer := 0;
  v_prob_cnt integer := 0;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT (
       public.staff_assistant_can_manage_ideas(v_uid)
       OR public.staff_assistant_crm_can_review()
     )
  THEN
    RAISE EXCEPTION 'Not authorized: Weekly unanswered question list is restricted to managers, CRM reviewers, the COO, and the CEO.'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    count(*) FILTER (WHERE f.rating = 'up')::integer,
    count(*) FILTER (WHERE f.rating = 'down')::integer,
    count(*) FILTER (WHERE f.report_kind = 'problem_report')::integer
    INTO v_up_cnt, v_down_cnt, v_prob_cnt
    FROM public.staff_assistant_feedback f
   WHERE f.created_at >= v_start;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'question', q.question_text,
        'role', q.caller_role,
        'outcome', q.outcome,
        'ask_count', q.ask_count,
        'last_seen_date', q.last_seen_date
      )
      ORDER BY q.ask_count DESC, q.last_seen_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM (
    SELECT
      (ARRAY_AGG(btrim(u.question_text) ORDER BY u.created_at DESC))[1] AS question_text,
      coalesce(
        nullif((ARRAY_AGG(coalesce(u.caller_roles[1], 'staff') ORDER BY u.created_at DESC))[1], ''),
        'staff'
      ) AS caller_role,
      coalesce((ARRAY_AGG(u.reason ORDER BY u.created_at DESC))[1], 'unmatched') AS outcome,
      count(*)::integer AS ask_count,
      max(u.created_at) AS last_seen_at,
      (max(u.created_at) AT TIME ZONE 'Africa/Kampala')::date AS last_seen_date
    FROM public.staff_assistant_unanswered u
    WHERE u.created_at >= v_start
      AND btrim(coalesce(u.question_text, '')) <> ''
    GROUP BY lower(regexp_replace(btrim(coalesce(u.question_text, '')), '\s+', ' ', 'g'))
    ORDER BY count(*) DESC, max(u.created_at) DESC
    LIMIT 25
  ) q;

  RETURN jsonb_build_object(
    'source', 'staff_assistant_weekly_unanswered_list (redacted: question, role, outcome only)',
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_today,
      'days', v_days,
      'timezone', 'Africa/Kampala'
    ),
    'redacted', true,
    'feedback_summary', jsonb_build_object(
      'thumbs_up_count', coalesce(v_up_cnt, 0),
      'thumbs_down_count', coalesce(v_down_cnt, 0),
      'problem_reports_count', coalesce(v_prob_cnt, 0)
    ),
    'row_count', jsonb_array_length(v_rows),
    'rows', v_rows
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_weekly_unanswered_list(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_weekly_unanswered_list(integer) TO authenticated;

COMMENT ON FUNCTION public.staff_assistant_weekly_unanswered_list(integer) IS
  'Weekly redacted list of questions Zoe could not answer for managers (question, role, outcome only — never answer text or figures) plus feedback counts.';

-- -----------------------------------------------------------------------------
-- 5. Upgrade `public.staff_assistant_weekly_look_at_summary`
--    Includes:
--      - `issues` (top 5 operational & quality items)
--      - `unanswered_questions` (weekly redacted list: question, role, outcome, ask_count)
--      - `feedback_summary` (thumbs_up_count, thumbs_down_count, problem_reports_count)
--      - `anomaly_notes` (notable 4-week comparisons from `staff_assistant_insights`)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_weekly_look_at_summary(
  p_as_of date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid              uuid := (SELECT auth.uid());
  v_today            date := COALESCE(p_as_of, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_monday           date := date_trunc('week', v_today::timestamp)::date;
  v_is_monday        boolean := (EXTRACT(ISODOW FROM v_today) = 1);
  v_week_window_from timestamptz := ((v_today - 6)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_ids              uuid[];
  v_timing           jsonb := '{}'::jsonb;
  v_top_desk         text := 'tenant_ops';
  v_desk_cnt         integer := 0;
  v_desk_avg_hrs     numeric := 0;
  v_not_paid         record;
  v_silent_cnt       integer := 0;
  v_reach_pct        numeric := 0;
  v_calls_total      integer := 0;
  v_unans_cnt        integer := 0;
  v_up_cnt           integer := 0;
  v_down_cnt         integer := 0;
  v_prob_cnt         integer := 0;
  v_new_ideas_cnt    integer := 0;
  v_items            jsonb;
  v_unanswered_list  jsonb := '[]'::jsonb;
  v_anomaly_notes    jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_can_manage_ideas(v_uid) THEN
    RAISE EXCEPTION 'Not authorized: Weekly "What to look at this week" summary is for managers, the COO, and the CEO.'
      USING ERRCODE = '42501';
  END IF;

  -- Issue 1: Desk wait bottleneck (`rent_request_timing`)
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
       ORDER BY rr.created_at ASC
       LIMIT 100
    ) q;

  IF cardinality(v_ids) > 0 THEN
    BEGIN
      v_timing := public.rent_request_timing(v_ids);
      SELECT
        coalesce(nullif(tr.val -> 'current_desk' ->> 'desk', ''), 'tenant_ops'),
        count(*)::integer,
        round(avg(coalesce((tr.val -> 'current_desk' ->> 'elapsed_seconds')::numeric, 0) / 3600.0), 1)
      INTO v_top_desk, v_desk_cnt, v_desk_avg_hrs
      FROM jsonb_array_elements(coalesce(v_timing -> 'rows', '[]'::jsonb)) AS tr(val)
      GROUP BY coalesce(nullif(tr.val -> 'current_desk' ->> 'desk', ''), 'tenant_ops')
      ORDER BY avg(coalesce((tr.val -> 'current_desk' ->> 'elapsed_seconds')::numeric, 0)) DESC, count(*) DESC
      LIMIT 1;
    EXCEPTION
      WHEN OTHERS THEN
        v_top_desk := 'tenant_ops';
        v_desk_cnt := cardinality(v_ids);
        v_desk_avg_hrs := 0;
    END;
  END IF;

  -- Issue 2: Funded Rent Plans awaiting landlord payout (`tops_landlord_not_paid_summary_amclock`)
  BEGIN
    SELECT *
      INTO v_not_paid
      FROM public.tops_landlord_not_paid_summary_amclock()
     LIMIT 1;
  EXCEPTION
    WHEN OTHERS THEN
      v_not_paid := NULL;
  END;

  -- Issue 3: Silent collectors / collection coverage (`agent_ops_silent_collectors`)
  BEGIN
    SELECT count(*)::integer
      INTO v_silent_cnt
      FROM public.agent_ops_silent_collectors(3, 200);
  EXCEPTION
    WHEN OTHERS THEN
      v_silent_cnt := 0;
  END;

  -- Issue 4: Calling Center reach rate over the last 7 days (`cc_call_attempts`)
  SELECT
    count(*)::integer,
    CASE
      WHEN count(*) > 0
        THEN round((count(*) FILTER (WHERE a.outcome::text = 'engaged')::numeric / count(*)::numeric) * 100.0, 1)
      ELSE 0::numeric
    END
  INTO v_calls_total, v_reach_pct
  FROM public.cc_call_attempts a
  WHERE a.void_reason IS NULL
    AND a.outcome IS NOT NULL
    AND coalesce(a.recorded_at, a.created_at) >= v_week_window_from;

  -- Issue 5: Zoe unanswered questions & feedback (`staff_assistant_unanswered` + `staff_assistant_feedback`)
  SELECT count(*)::integer
    INTO v_unans_cnt
    FROM public.staff_assistant_unanswered u
   WHERE u.created_at >= v_week_window_from
     AND u.status = 'open';

  SELECT
    count(*) FILTER (WHERE f.rating = 'up')::integer,
    count(*) FILTER (WHERE f.rating = 'down')::integer,
    count(*) FILTER (WHERE f.report_kind = 'problem_report')::integer
    INTO v_up_cnt, v_down_cnt, v_prob_cnt
    FROM public.staff_assistant_feedback f
   WHERE f.created_at >= v_week_window_from;

  SELECT count(*)::integer
    INTO v_new_ideas_cnt
    FROM public.staff_assistant_ideas i
   WHERE i.status = 'new';

  -- Redacted weekly "Questions Zoe could not answer" list (question, role, outcome only)
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'question', q.question_text,
        'role', q.caller_role,
        'outcome', q.outcome,
        'ask_count', q.ask_count
      )
      ORDER BY q.ask_count DESC, q.last_seen_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_unanswered_list
  FROM (
    SELECT
      (ARRAY_AGG(btrim(u.question_text) ORDER BY u.created_at DESC))[1] AS question_text,
      coalesce(
        nullif((ARRAY_AGG(coalesce(u.caller_roles[1], 'staff') ORDER BY u.created_at DESC))[1], ''),
        'staff'
      ) AS caller_role,
      coalesce((ARRAY_AGG(u.reason ORDER BY u.created_at DESC))[1], 'unmatched') AS outcome,
      count(*)::integer AS ask_count,
      max(u.created_at) AS last_seen_at
    FROM public.staff_assistant_unanswered u
    WHERE u.created_at >= v_week_window_from
      AND btrim(coalesce(u.question_text, '')) <> ''
    GROUP BY lower(regexp_replace(btrim(coalesce(u.question_text, '')), '\s+', ' ', 'g'))
    ORDER BY count(*) DESC, max(u.created_at) DESC
    LIMIT 15
  ) q;

  -- Notable 4-week anomaly notes from `staff_assistant_insights`
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'category', ins.category,
        'title', ins.title,
        'summary', ins.summary,
        'pct_change', ins.pct_change,
        'direction', ins.direction,
        'source_function', ins.source_function,
        'period_label', ins.period_label,
        'screen_path', ins.screen_path
      )
      ORDER BY ins.kampala_date DESC, abs(ins.pct_change) DESC
    ),
    '[]'::jsonb
  )
  INTO v_anomaly_notes
  FROM (
    SELECT *
      FROM public.staff_assistant_insights i
     WHERE i.kampala_date >= v_today - 7
       AND i.is_notable = true
     ORDER BY i.kampala_date DESC, abs(i.pct_change) DESC
     LIMIT 6
  ) ins;

  v_items := jsonb_build_array(
    jsonb_build_object(
      'rank', 1,
      'category', 'desk_wait',
      'title', format('Rent Plan desk wait times (%s)', coalesce(v_top_desk, 'tenant_ops')),
      'evidence', format(
        '%s open Rent Plan requests on %s averaging %s hours on desk (%s open across all desks).',
        coalesce(v_desk_cnt, 0),
        coalesce(v_top_desk, 'tenant_ops'),
        coalesce(v_desk_avg_hrs, 0),
        cardinality(v_ids)
      ),
      'metric_label', format('%s hrs avg wait', coalesce(v_desk_avg_hrs, 0)),
      'source', 'rent_request_timing',
      'screen_path', '/tenant-ops/workspace',
      'screen_label', 'Open Tenant Ops Workspace'
    ),
    jsonb_build_object(
      'rank', 2,
      'category', 'payouts',
      'title', 'Funded Rent Plans awaiting landlord payment',
      'evidence', format(
        '%s total funded Rent Plans awaiting landlord payout (%s where tenant is already repaying; %s awaiting landlord details).',
        coalesce(v_not_paid.total_plans, 0),
        coalesce(v_not_paid.tenant_paying_no_landlord, 0),
        coalesce(v_not_paid.awaiting_landlord, 0)
      ),
      'metric_label', format('%s plans waiting', coalesce(v_not_paid.total_plans, 0)),
      'source', 'tops_landlord_not_paid_summary_amclock',
      'screen_path', '/landlord-ops',
      'screen_label', 'Open Landlord Ops'
    ),
    jsonb_build_object(
      'rank', 3,
      'category', 'collections',
      'title', 'Collection coverage & silent field collectors',
      'evidence', format(
        '%s field agents with active Rent Plans have been silent for 3 or more days.',
        coalesce(v_silent_cnt, 0)
      ),
      'metric_label', format('%s silent collectors', coalesce(v_silent_cnt, 0)),
      'source', 'agent_ops_silent_collectors',
      'screen_path', '/executive-hub?tab=agent-ops',
      'screen_label', 'Open Agent Ops'
    ),
    jsonb_build_object(
      'rank', 4,
      'category', 'calling',
      'title', 'Calling Center reach rate & follow-ups',
      'evidence', format(
        '%s%% engaged reach rate across %s logged call attempts over the last 7 days.',
        coalesce(v_reach_pct, 0),
        coalesce(v_calls_total, 0)
      ),
      'metric_label', format('%s%% reach rate', coalesce(v_reach_pct, 0)),
      'source', 'cc_weekly_all_calls_report',
      'screen_path', '/me/staff-reports',
      'screen_label', 'Open Calling Reports'
    ),
    jsonb_build_object(
      'rank', 5,
      'category', 'zoe_quality',
      'title', 'Zoe unanswered questions & saved staff ideas',
      'evidence', format(
        '%s open unanswered questions, %s thumbs-down ratings (%s reported problems) this week, and %s new saved ideas awaiting manager review.',
        coalesce(v_unans_cnt, 0),
        coalesce(v_down_cnt, 0),
        coalesce(v_prob_cnt, 0),
        coalesce(v_new_ideas_cnt, 0)
      ),
      'metric_label', format('%s new ideas · %s unanswered', coalesce(v_new_ideas_cnt, 0), coalesce(v_unans_cnt, 0)),
      'source', 'staff_assistant_unanswered + staff_assistant_ideas',
      'screen_path', '/me/ideas',
      'screen_label', 'Review Saved Ideas'
    )
  );

  RETURN jsonb_build_object(
    'source', 'staff_assistant_weekly_look_at_summary',
    'week_start', v_monday,
    'as_of', v_today,
    'is_monday', v_is_monday,
    'in_app_only', true,
    'new_ideas_count', coalesce(v_new_ideas_cnt, 0),
    'feedback_summary', jsonb_build_object(
      'thumbs_up_count', coalesce(v_up_cnt, 0),
      'thumbs_down_count', coalesce(v_down_cnt, 0),
      'problem_reports_count', coalesce(v_prob_cnt, 0)
    ),
    'unanswered_questions', v_unanswered_list,
    'anomaly_notes', v_anomaly_notes,
    'issues', v_items
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_weekly_look_at_summary(date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_weekly_look_at_summary(date) TO authenticated;

COMMIT;
