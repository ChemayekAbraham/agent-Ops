-- =============================================================================
-- Migration: 20261104233000_staff_assistant_weekly_adoption_trend.sql
-- Purpose:
--   Prompt 3 Deliverable (2) — Add a plain weekly adoption number and an
--   8-week trend line to the existing manager-only usage dashboard
--   (`public.staff_assistant_real_use_dashboard(p_days integer DEFAULT 14)`):
--     - `weekly_active_staff`: distinct staff who used Zoe at least once in
--       the last 7 Kampala days (counted across `staff_assistant_messages`).
--     - `baseline_weekly_active_staff`: 1 (recorded baseline in the 7 days
--       before this round of work began).
--     - `weekly_adoption_trend`: 8-week chronological array of
--       `{ week_start, week_end, week_label, distinct_staff_count, questions_count }`
--       ending on the current Kampala day so managers see both the plain weekly
--       adoption count and a simple trend line.
--   Read-only. Preserves all existing dashboard fields (`model_drift`,
--   `summary`, `by_day_and_role`, `questions_per_role`, `cost_per_day_usd`,
--   `top_unanswered_themes`, `errors_by_code`, `models_used`).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.staff_assistant_real_use_dashboard(
  p_days integer DEFAULT 14
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 14), 1), 90);
  v_today_kampala date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_since timestamptz := (
    (v_today_kampala - (LEAST(GREATEST(COALESCE(p_days, 14), 1), 90) - 1))::timestamp
    AT TIME ZONE 'Africa/Kampala'
  );
  v_since_7d timestamptz := (
    (v_today_kampala - 6)::timestamp AT TIME ZONE 'Africa/Kampala'
  );
  v_today_start timestamptz := (
    v_today_kampala::timestamp AT TIME ZONE 'Africa/Kampala'
  );
  v_summary jsonb;
  v_by_day_and_role jsonb;
  v_questions_per_role jsonb;
  v_cost_per_day jsonb;
  v_top_unanswered jsonb;
  v_errors_by_code jsonb;
  v_models_used jsonb;
  v_model_drift jsonb;
  v_weekly_adoption_trend jsonb;
  v_daily_active integer := 0;
  v_weekly_active integer := 0;
  v_total_questions integer := 0;
  v_answered_count integer := 0;
  v_error_count integer := 0;
  v_thumbs_up integer := 0;
  v_thumbs_down integer := 0;
  v_median_ttfb integer := 0;
  v_p95_ttfb integer := 0;
  v_median_total integer := 0;
  v_p95_total integer := 0;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_crm_can_review() THEN
    RAISE EXCEPTION 'Not authorized: manager or CRM review role required for staff_assistant_real_use_dashboard.'
      USING ERRCODE = '42501';
  END IF;

  -- Distinct staff who used Zoe today and in the last 7 Kampala days
  SELECT
    count(DISTINCT m.user_id) FILTER (WHERE m.created_at >= v_today_start),
    count(DISTINCT m.user_id) FILTER (WHERE m.created_at >= v_since_7d)
  INTO v_daily_active, v_weekly_active
  FROM public.staff_assistant_messages m
  WHERE m.created_at >= LEAST(v_since, v_since_7d);

  -- 8-week chronological adoption trend (each bucket is a 7-day Kampala window ending on week_end)
  WITH week_series AS (
    SELECT
      gs AS week_idx,
      (v_today_kampala - ((7 - gs) * 7) - 6)::date AS week_start,
      (v_today_kampala - ((7 - gs) * 7))::date AS week_end
    FROM generate_series(0, 7) AS gs
  ),
  week_stats AS (
    SELECT
      ws.week_start::text AS week_start,
      ws.week_end::text AS week_end,
      to_char(ws.week_start, 'DD Mon') || ' – ' || to_char(ws.week_end, 'DD Mon') AS week_label,
      COALESCE(count(DISTINCT m.user_id), 0)::integer AS distinct_staff_count,
      COALESCE(count(*) FILTER (WHERE m.role = 'assistant'), 0)::integer AS questions_count
    FROM week_series ws
    LEFT JOIN public.staff_assistant_messages m
      ON (m.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN ws.week_start AND ws.week_end
    GROUP BY ws.week_idx, ws.week_start, ws.week_end
    ORDER BY ws.week_idx ASC
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(week_stats)), '[]'::jsonb)
  INTO v_weekly_adoption_trend
  FROM week_stats;

  WITH assistant_turns AS (
    SELECT
      m.id,
      m.user_id,
      (m.created_at AT TIME ZONE 'Africa/Kampala')::date AS day_kampala,
      COALESCE(m.outcome, 'answered') AS outcome,
      COALESCE(m.ttfb_ms, m.latency_ms) AS ttfb_ms,
      m.latency_ms,
      COALESCE(m.requested_model, m.model, 'unknown') AS requested_model,
      COALESCE(m.gateway_model, m.model, 'unknown') AS gateway_model,
      COALESCE(m.cost_usd, 0)::numeric AS cost_usd,
      (m.analyst_used OR ('run_analyst_query' = ANY(m.tools_called))) AS is_analyst,
      (
        m.research_used
        OR ('search_web' = ANY(m.tools_called))
        OR ('read_web_page' = ANY(m.tools_called))
      ) AS is_research
    FROM public.staff_assistant_messages m
    WHERE m.role = 'assistant'
      AND m.created_at >= v_since
  ),
  feedback_window AS (
    SELECT
      f.rating,
      (f.created_at AT TIME ZONE 'Africa/Kampala')::date AS day_kampala,
      f.user_id
    FROM public.staff_assistant_feedback f
    WHERE f.created_at >= v_since
  )
  SELECT
    COALESCE((SELECT count(*)::integer FROM assistant_turns), 0),
    COALESCE((SELECT count(*)::integer FROM assistant_turns WHERE outcome = 'answered'), 0),
    COALESCE((SELECT count(*)::integer FROM assistant_turns WHERE outcome IN ('error', 'missing_tool', 'unmatched')), 0),
    COALESCE((SELECT count(*)::integer FROM feedback_window WHERE rating = 'up'), 0),
    COALESCE((SELECT count(*)::integer FROM feedback_window WHERE rating = 'down'), 0),
    COALESCE((
      SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY ttfb_ms))::integer
      FROM assistant_turns
      WHERE ttfb_ms IS NOT NULL AND ttfb_ms > 0
    ), 0),
    COALESCE((
      SELECT ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY ttfb_ms))::integer
      FROM assistant_turns
      WHERE ttfb_ms IS NOT NULL AND ttfb_ms > 0
    ), 0),
    COALESCE((
      SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms))::integer
      FROM assistant_turns
      WHERE latency_ms IS NOT NULL AND latency_ms > 0
    ), 0),
    COALESCE((
      SELECT ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms))::integer
      FROM assistant_turns
      WHERE latency_ms IS NOT NULL AND latency_ms > 0
    ), 0),
    jsonb_build_object(
      'active_users', COALESCE((SELECT count(DISTINCT user_id) FROM assistant_turns), 0),
      'weekly_active_staff', COALESCE(v_weekly_active, 0),
      'baseline_weekly_active_staff', 1,
      'questions', COALESCE((SELECT count(*) FROM assistant_turns), 0),
      'answered_count', COALESCE((SELECT count(*) FROM assistant_turns WHERE outcome = 'answered'), 0),
      'answered_pct', CASE
        WHEN COALESCE((SELECT count(*) FROM assistant_turns), 0) > 0 THEN
          ROUND(
            (
              (SELECT count(*)::numeric FROM assistant_turns WHERE outcome = 'answered')
              * 100.0
              / (SELECT count(*)::numeric FROM assistant_turns)
            ),
            1
          )
        ELSE 0.0
      END,
      'refusals', COALESCE(
        (SELECT count(*) FROM assistant_turns WHERE outcome IN ('blocked', 'out_of_scope', 'not_staff')),
        0
      ),
      'errors', COALESCE(
        (SELECT count(*) FROM assistant_turns WHERE outcome IN ('error', 'missing_tool', 'unmatched')),
        0
      ),
      'median_ttfb_ms', COALESCE((
        SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY ttfb_ms))::integer
        FROM assistant_turns
        WHERE ttfb_ms IS NOT NULL AND ttfb_ms > 0
      ), 0),
      'p95_ttfb_ms', COALESCE((
        SELECT ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY ttfb_ms))::integer
        FROM assistant_turns
        WHERE ttfb_ms IS NOT NULL AND ttfb_ms > 0
      ), 0),
      'total_cost_usd', COALESCE(
        (SELECT ROUND(SUM(cost_usd), 6) FROM assistant_turns),
        0
      ),
      'thumbs_up', COALESCE((SELECT count(*) FROM feedback_window WHERE rating = 'up'), 0),
      'thumbs_down', COALESCE((SELECT count(*) FROM feedback_window WHERE rating = 'down'), 0),
      'analyst_use_count', COALESCE((SELECT count(*) FROM assistant_turns WHERE is_analyst), 0),
      'research_use_count', COALESCE((SELECT count(*) FROM assistant_turns WHERE is_research), 0)
    )
  INTO
    v_total_questions,
    v_answered_count,
    v_error_count,
    v_thumbs_up,
    v_thumbs_down,
    v_median_ttfb,
    v_p95_ttfb,
    v_median_total,
    v_p95_total,
    v_summary;

  WITH user_primary_role AS (
    SELECT
      ur.user_id,
      COALESCE(
        (
          SELECT r.role::text
          FROM public.user_roles r
          WHERE r.user_id = ur.user_id
            AND COALESCE(r.enabled, true) = true
          ORDER BY CASE r.role::text
            WHEN 'ceo' THEN 1
            WHEN 'cfo' THEN 2
            WHEN 'coo' THEN 3
            WHEN 'cto' THEN 4
            WHEN 'super_admin' THEN 5
            WHEN 'crm' THEN 6
            WHEN 'hr' THEN 7
            WHEN 'financial_ops' THEN 8
            WHEN 'tenant_ops' THEN 9
            WHEN 'landlord_ops' THEN 10
            WHEN 'agent_ops' THEN 11
            WHEN 'partner_ops' THEN 12
            WHEN 'manager' THEN 13
            ELSE 20
          END
          LIMIT 1
        ),
        'employee'
      ) AS role_name
    FROM (
      SELECT DISTINCT user_id
      FROM public.staff_assistant_messages
      WHERE created_at >= v_since
    ) ur
  ),
  turns_with_role AS (
    SELECT
      (m.created_at AT TIME ZONE 'Africa/Kampala')::date AS day_kampala,
      COALESCE(upr.role_name, 'employee') AS role_name,
      m.user_id,
      COALESCE(m.outcome, 'answered') AS outcome,
      COALESCE(m.ttfb_ms, m.latency_ms) AS ttfb_ms,
      COALESCE(m.gateway_model, m.model, 'unknown') AS gateway_model,
      COALESCE(m.requested_model, m.model, 'unknown') AS requested_model,
      COALESCE(m.cost_usd, 0)::numeric AS cost_usd,
      (m.analyst_used OR ('run_analyst_query' = ANY(m.tools_called))) AS is_analyst,
      (
        m.research_used
        OR ('search_web' = ANY(m.tools_called))
        OR ('read_web_page' = ANY(m.tools_called))
      ) AS is_research
    FROM public.staff_assistant_messages m
    LEFT JOIN user_primary_role upr ON upr.user_id = m.user_id
    WHERE m.role = 'assistant'
      AND m.created_at >= v_since
  ),
  feedback_by_day_role AS (
    SELECT
      (f.created_at AT TIME ZONE 'Africa/Kampala')::date AS day_kampala,
      COALESCE(upr.role_name, 'employee') AS role_name,
      count(*) FILTER (WHERE f.rating = 'up') AS thumbs_up,
      count(*) FILTER (WHERE f.rating = 'down') AS thumbs_down
    FROM public.staff_assistant_feedback f
    LEFT JOIN user_primary_role upr ON upr.user_id = f.user_id
    WHERE f.created_at >= v_since
    GROUP BY 1, 2
  ),
  grouped AS (
    SELECT
      t.day_kampala,
      t.role_name,
      count(DISTINCT t.user_id) AS active_users,
      count(*) AS questions,
      count(*) FILTER (WHERE t.outcome = 'answered') AS answered_count,
      ROUND(
        (count(*) FILTER (WHERE t.outcome = 'answered'))::numeric * 100.0
        / NULLIF(count(*)::numeric, 0),
        1
      ) AS answered_pct,
      count(*) FILTER (WHERE t.outcome IN ('blocked', 'out_of_scope', 'not_staff')) AS refusals,
      count(*) FILTER (WHERE t.outcome IN ('error', 'missing_tool', 'unmatched')) AS errors,
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY t.ttfb_ms) FILTER (WHERE t.ttfb_ms IS NOT NULL AND t.ttfb_ms > 0))::integer AS median_ttfb_ms,
      ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY t.ttfb_ms) FILTER (WHERE t.ttfb_ms IS NOT NULL AND t.ttfb_ms > 0))::integer AS p95_ttfb_ms,
      mode() WITHIN GROUP (ORDER BY t.gateway_model) AS model_used,
      mode() WITHIN GROUP (ORDER BY t.requested_model) AS requested_model,
      ROUND(SUM(t.cost_usd), 6) AS cost_usd,
      COALESCE(fb.thumbs_up, 0) AS thumbs_up,
      COALESCE(fb.thumbs_down, 0) AS thumbs_down,
      count(*) FILTER (WHERE t.is_analyst) AS analyst_use_count,
      count(*) FILTER (WHERE t.is_research) AS research_use_count
    FROM turns_with_role t
    LEFT JOIN feedback_by_day_role fb
      ON fb.day_kampala = t.day_kampala AND fb.role_name = t.role_name
    GROUP BY t.day_kampala, t.role_name, fb.thumbs_up, fb.thumbs_down
    ORDER BY t.day_kampala DESC, questions DESC, t.role_name ASC
  ),
  role_rollup AS (
    SELECT
      g.role_name AS role_bucket,
      SUM(g.questions)::integer AS questions_count,
      SUM(g.answered_count)::integer AS answered_count,
      SUM(g.errors)::integer AS error_count,
      SUM(g.thumbs_up)::integer AS thumbs_up_count,
      SUM(g.thumbs_down)::integer AS thumbs_down_count
    FROM grouped g
    GROUP BY g.role_name
    ORDER BY SUM(g.questions) DESC, g.role_name ASC
  ),
  daily_cost AS (
    SELECT
      g.day_kampala::text AS day_kampala,
      SUM(g.questions)::integer AS questions_count,
      ROUND(SUM(g.cost_usd), 6) AS cost_usd
    FROM grouped g
    GROUP BY g.day_kampala
    ORDER BY g.day_kampala DESC
  )
  SELECT
    COALESCE((SELECT jsonb_agg(to_jsonb(grouped)) FROM grouped), '[]'::jsonb),
    COALESCE((SELECT jsonb_agg(to_jsonb(role_rollup)) FROM role_rollup), '[]'::jsonb),
    COALESCE((SELECT jsonb_agg(to_jsonb(daily_cost)) FROM daily_cost), '[]'::jsonb)
  INTO v_by_day_and_role, v_questions_per_role, v_cost_per_day;

  WITH err_rows AS (
    SELECT
      COALESCE(NULLIF(btrim(u.error_code), ''), 'ERR_TURN_FAILED') AS error_code,
      u.reason,
      count(*) AS error_count,
      count(DISTINCT u.user_id) AS affected_users,
      max(u.created_at) AS last_seen_at
    FROM public.staff_assistant_unanswered u
    WHERE u.created_at >= v_since
    GROUP BY 1, 2
    ORDER BY error_count DESC, last_seen_at DESC
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(err_rows)), '[]'::jsonb)
  INTO v_errors_by_code
  FROM err_rows;

  WITH unanswered_themes AS (
    SELECT
      COALESCE(NULLIF(btrim(l.topic), ''), 'general') AS topic,
      COALESCE(NULLIF(btrim(l.outcome), ''), 'unmatched') AS outcome,
      count(*)::integer AS count
    FROM public.staff_assistant_learning_log l
    WHERE l.created_at >= v_since
      AND l.outcome IN ('unmatched', 'error', 'blocked', 'out_of_scope')
    GROUP BY 1, 2
    ORDER BY count(*) DESC
    LIMIT 10
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(unanswered_themes)), '[]'::jsonb)
  INTO v_top_unanswered
  FROM unanswered_themes;

  WITH model_rows AS (
    SELECT
      COALESCE(m.requested_model, m.model, 'unknown') AS requested_model,
      COALESCE(m.gateway_model, m.model, 'unknown') AS gateway_model,
      count(*) AS turn_count,
      count(*) FILTER (WHERE m.outcome = 'answered') AS answered_count,
      count(*) FILTER (WHERE m.outcome = 'error') AS error_count,
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY COALESCE(m.ttfb_ms, m.latency_ms)) FILTER (WHERE COALESCE(m.ttfb_ms, m.latency_ms) > 0))::integer AS median_ttfb_ms,
      ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY COALESCE(m.ttfb_ms, m.latency_ms)) FILTER (WHERE COALESCE(m.ttfb_ms, m.latency_ms) > 0))::integer AS p95_ttfb_ms,
      ROUND(SUM(COALESCE(m.cost_usd, 0)), 6) AS total_cost_usd
    FROM public.staff_assistant_messages m
    WHERE m.role = 'assistant'
      AND m.created_at >= v_since
    GROUP BY 1, 2
    ORDER BY turn_count DESC
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(model_rows)), '[]'::jsonb)
  INTO v_models_used
  FROM model_rows;

  v_model_drift := public.staff_assistant_check_model_drift(50);

  RETURN jsonb_build_object(
    'ok', true,
    'source', 'staff_assistant_real_use_dashboard',
    'days', v_days,
    'window_days', v_days,
    'from_date', (v_today_kampala - (v_days - 1))::text,
    'to_date', v_today_kampala::text,
    'daily_active_staff', COALESCE(v_daily_active, 0),
    'weekly_active_staff', COALESCE(v_weekly_active, 0),
    'baseline_weekly_active_staff', 1,
    'weekly_adoption_trend', COALESCE(v_weekly_adoption_trend, '[]'::jsonb),
    'questions_per_role', COALESCE(v_questions_per_role, '[]'::jsonb),
    'answer_rate_pct', CASE
      WHEN v_total_questions > 0 THEN ROUND((v_answered_count::numeric * 100.0) / v_total_questions::numeric, 1)
      ELSE 0.0
    END,
    'error_rate_pct', CASE
      WHEN v_total_questions > 0 THEN ROUND((v_error_count::numeric * 100.0) / v_total_questions::numeric, 1)
      ELSE 0.0
    END,
    'thumbs_up_rate_pct', CASE
      WHEN (v_thumbs_up + v_thumbs_down) > 0 THEN ROUND((v_thumbs_up::numeric * 100.0) / (v_thumbs_up + v_thumbs_down)::numeric, 1)
      ELSE 0.0
    END,
    'median_ttfb_ms', COALESCE(v_median_ttfb, 0),
    'p95_ttfb_ms', COALESCE(v_p95_ttfb, 0),
    'median_total_ms', COALESCE(v_median_total, 0),
    'p95_total_ms', COALESCE(v_p95_total, 0),
    'cost_per_day_usd', COALESCE(v_cost_per_day, '[]'::jsonb),
    'top_unanswered_themes', COALESCE(v_top_unanswered, '[]'::jsonb),
    'summary', COALESCE(v_summary, '{}'::jsonb),
    'by_day_and_role', COALESCE(v_by_day_and_role, '[]'::jsonb),
    'errors_by_code', COALESCE(v_errors_by_code, '[]'::jsonb),
    'models_used', COALESCE(v_models_used, '[]'::jsonb),
    'model_drift', v_model_drift
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_real_use_dashboard(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_real_use_dashboard(integer) TO authenticated;

COMMIT;
