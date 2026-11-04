-- =============================================================================
-- Migration: 20261104190000_staff_assistant_model_drift_check.sql
-- Purpose:   Prompt 2 item (3) — Make silent AI gateway model drift impossible:
--              1. `public.staff_assistant_check_model_drift(p_limit integer DEFAULT 50)`:
--                 Read-only, caller-checked RPC that compares the most recent 50
--                 assistant replies' actual `gateway_model` against
--                 `staff_assistant_config.model_fast` and `model_deep`, returning
--                 `drift_detected`, `checked_count`, `mismatched_count`,
--                 `configured_model_fast`, `configured_model_deep`,
--                 `dominant_gateway_model`, `observed_models`, and `warning_message`.
--              2. Update `public.staff_assistant_health()` to verify
--                 `staff_assistant_check_model_drift` and embed `model_drift` in its
--                 health payload so `ZoeHealthBanner` can surface model drift warnings.
--              3. Update `public.staff_assistant_real_use_dashboard(p_days integer DEFAULT 14)`
--                 to include `model_drift` alongside its usage metrics.
-- Safety:    100% read-only (`STABLE SECURITY DEFINER SET search_path = public`).
--            Zero writes to business tables, wallets, or ledger.
-- =============================================================================

BEGIN;

-- 1. Read-only model drift detector over the most recent N assistant replies
CREATE OR REPLACE FUNCTION public.staff_assistant_check_model_drift(
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_model_fast text := 'google/gemini-2.5-flash';
  v_model_deep text := 'google/gemini-2.5-pro';
  v_fast_slug text;
  v_deep_slug text;
  v_checked_count integer := 0;
  v_mismatched_count integer := 0;
  v_dominant_gateway text := NULL;
  v_observed jsonb := '[]'::jsonb;
  v_drift_detected boolean := false;
  v_warning text := NULL;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required for staff_assistant_check_model_drift.'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    COALESCE(NULLIF(btrim(c.model_fast), ''), 'google/gemini-2.5-flash'),
    COALESCE(NULLIF(btrim(c.model_deep), ''), 'google/gemini-2.5-pro')
  INTO v_model_fast, v_model_deep
  FROM public.staff_assistant_config c
  WHERE c.id = true
  LIMIT 1;

  v_fast_slug := lower(regexp_replace(v_model_fast, '^[a-z0-9_-]+/', ''));
  v_deep_slug := lower(regexp_replace(v_model_deep, '^[a-z0-9_-]+/', ''));

  WITH recent_replies AS (
    SELECT
      m.id,
      m.created_at,
      COALESCE(NULLIF(btrim(m.requested_model), ''), NULLIF(btrim(m.model), ''), 'unknown') AS requested_model,
      COALESCE(NULLIF(btrim(m.gateway_model), ''), NULLIF(btrim(m.model), '')) AS gateway_model,
      lower(
        regexp_replace(
          COALESCE(NULLIF(btrim(m.gateway_model), ''), NULLIF(btrim(m.model), '')),
          '^[a-z0-9_-]+/',
          ''
        )
      ) AS gateway_slug
    FROM public.staff_assistant_messages m
    WHERE m.role = 'assistant'
      AND COALESCE(NULLIF(btrim(m.gateway_model), ''), NULLIF(btrim(m.model), '')) IS NOT NULL
      AND lower(COALESCE(NULLIF(btrim(m.gateway_model), ''), NULLIF(btrim(m.model), ''))) NOT IN ('none', 'deterministic', 'cached')
    ORDER BY m.created_at DESC
    LIMIT v_limit
  ),
  annotated AS (
    SELECT
      r.*,
      (
        lower(r.gateway_model) IN (lower(v_model_fast), lower(v_model_deep))
        OR r.gateway_slug IN (v_fast_slug, v_deep_slug)
      ) AS matches_config
    FROM recent_replies r
  ),
  grouped AS (
    SELECT
      a.gateway_model,
      mode() WITHIN GROUP (ORDER BY a.requested_model) AS requested_model,
      count(*)::integer AS turn_count,
      bool_and(a.matches_config) AS matches_config,
      max(a.created_at) AS last_seen_at
    FROM annotated a
    GROUP BY a.gateway_model
    ORDER BY count(*) DESC, max(a.created_at) DESC
  )
  SELECT
    COALESCE((SELECT count(*)::integer FROM annotated), 0),
    COALESCE((SELECT count(*)::integer FROM annotated WHERE NOT matches_config), 0),
    (SELECT g.gateway_model FROM grouped g WHERE NOT g.matches_config ORDER BY g.turn_count DESC LIMIT 1),
    COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM grouped g), '[]'::jsonb)
  INTO v_checked_count, v_mismatched_count, v_dominant_gateway, v_observed;

  IF v_dominant_gateway IS NULL THEN
    SELECT g->>'gateway_model'
    INTO v_dominant_gateway
    FROM jsonb_array_elements(v_observed) g
    LIMIT 1;
  END IF;

  v_drift_detected := (v_mismatched_count > 0);

  IF v_drift_detected THEN
    v_warning := format(
      'Model drift detected: %s of the last %s Zoe replies were answered by %s, which does not match staff_assistant_config (model_fast: %s, model_deep: %s).',
      v_mismatched_count,
      v_checked_count,
      COALESCE(v_dominant_gateway, 'an unconfigured model'),
      v_model_fast,
      v_model_deep
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'source', 'staff_assistant_check_model_drift',
    'sample_limit', v_limit,
    'checked_count', v_checked_count,
    'mismatched_count', v_mismatched_count,
    'drift_detected', v_drift_detected,
    'configured_model_fast', v_model_fast,
    'configured_model_deep', v_model_deep,
    'dominant_gateway_model', v_dominant_gateway,
    'observed_models', v_observed,
    'warning_message', v_warning,
    'checked_at', now()
  );
END;
$function$;

COMMENT ON FUNCTION public.staff_assistant_check_model_drift(integer) IS
  'Read-only model drift detector for Zoe: compares the most recent N assistant replies in staff_assistant_messages against staff_assistant_config.model_fast and model_deep.';

REVOKE ALL ON FUNCTION public.staff_assistant_check_model_drift(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_check_model_drift(integer) TO authenticated;

-- 2. Update staff_assistant_health() to verify staff_assistant_check_model_drift and include model_drift
CREATE OR REPLACE FUNCTION public.staff_assistant_health()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_required_tables constant text[] := ARRAY[
    'staff_assistant_config',
    'staff_assistant_conversations',
    'staff_assistant_messages',
    'staff_assistant_feedback',
    'staff_assistant_unanswered',
    'staff_assistant_reminders',
    'staff_assistant_schedules',
    'staff_assistant_preferences',
    'staff_assistant_drafts',
    'staff_assistant_insights',
    'staff_assistant_ideas',
    'staff_assistant_notes',
    'staff_assistant_glossary',
    'staff_assistant_data_catalog',
    'staff_assistant_queries',
    'staff_assistant_research_logs',
    'staff_assistant_learning_log',
    'staff_assistant_knowledge_base',
    'staff_assistant_projects',
    'staff_assistant_uploads',
    'staff_assistant_kb_zero_hits'
  ];
  v_required_columns constant text[] := ARRAY[
    'staff_assistant_config.model_fast',
    'staff_assistant_config.model_deep',
    'staff_assistant_config.temperature',
    'staff_assistant_config.max_tokens',
    'staff_assistant_config.max_model_rounds',
    'staff_assistant_config.max_tool_calls',
    'staff_assistant_config.max_deep_model_rounds',
    'staff_assistant_config.max_deep_tool_calls',
    'staff_assistant_config.max_cost_usd_per_question',
    'staff_assistant_config.web_research_enabled',
    'staff_assistant_conversations.hidden_by_user',
    'staff_assistant_conversations.rolling_summary',
    'staff_assistant_conversations.project_id',
    'staff_assistant_messages.hidden_by_user',
    'staff_assistant_messages.requested_model',
    'staff_assistant_messages.gateway_model',
    'staff_assistant_messages.ttfb_ms',
    'staff_assistant_messages.error_code',
    'staff_assistant_feedback.report_kind',
    'staff_assistant_unanswered.error_code',
    'staff_assistant_unanswered.error_detail',
    'staff_assistant_unanswered.routed_department',
    'staff_assistant_knowledge_base.created_by',
    'staff_assistant_knowledge_base.approved_by',
    'staff_assistant_knowledge_base.expires_at',
    'staff_assistant_preferences.web_push_enabled',
    'staff_assistant_preferences.web_push_morning_brief_topic',
    'staff_assistant_preferences.web_push_taught_updates_topic',
    'staff_assistant_preferences.voice_disclosure_acknowledged_at'
  ];
  v_required_views constant text[] := ARRAY[
    'zoe_ro.finance_treasury_cash_position',
    'zoe_ro.finance_receivables_and_payables',
    'zoe_ro.finance_requisitions_summary',
    'zoe_ro.finance_budget_cycles',
    'zoe_ro.operations_daily_collection_coverage',
    'zoe_ro.operations_rent_plans_by_stage',
    'zoe_ro.calling_daily_attempts_summary',
    'zoe_ro.calling_pipeline_awareness_summary',
    'zoe_ro.hr_department_headcount',
    'zoe_ro.hr_contracts_overview',
    'zoe_ro.agents_daily_collections_by_region',
    'zoe_ro.agents_house_listings_summary',
    'zoe_ro.supporters_portfolios_summary',
    'zoe_ro.supporters_promissory_notes_summary',
    'zoe_ro.tenants_rent_plans_by_city',
    'zoe_ro.tenants_arrears_by_city',
    'zoe_ro.landlords_registry_by_district',
    'zoe_ro.landlords_payouts_summary',
    'zoe_ro.calling_my_space_officer_daily',
    'zoe_ro.tenants_directory_by_stage_and_location',
    'zoe_ro.operations_desk_turnaround_summary',
    'zoe_ro.tenants_first_seven_days_cohort'
  ];
  v_required_functions constant text[] := ARRAY[
    'staff_assistant_has_access',
    'staff_assistant_get_config',
    'staff_assistant_can_user_read_report',
    'staff_assistant_save_draft',
    'staff_assistant_consume_draft',
    'staff_assistant_check_question_rate_limit',
    'staff_assistant_check_email_budget',
    'staff_assistant_hide_my_history',
    'staff_assistant_error_summary',
    'staff_assistant_real_use_dashboard',
    'staff_assistant_check_model_drift',
    'staff_assistant_upsert_project',
    'staff_assistant_list_projects',
    'staff_assistant_delete_project',
    'staff_assistant_department_teaching_queue',
    'staff_assistant_teach_from_review_queue',
    'staff_assistant_role_goals_and_measures',
    'staff_assistant_can_send_web_push',
    'staff_assistant_update_push_and_voice_prefs',
    'assistant_staff_get_glossary',
    'assistant_staff_data_catalog',
    'assistant_staff_get_data_catalog',
    'assistant_staff_run_query',
    'assistant_staff_my_work_summary',
    'assistant_staff_team_work_summary',
    'assistant_staff_search_knowledge_base',
    'assistant_staff_my_taught_updates',
    'assistant_staff_my_reminders_and_schedules',
    'assistant_staff_my_calls',
    'assistant_staff_tops_rent_requests_by_stage',
    'assistant_staff_tops_time_on_desk',
    'assistant_staff_tops_find_tenant',
    'assistant_staff_tops_awareness_calls',
    'assistant_staff_lops_verification_queue',
    'assistant_staff_aops_subagent_teams',
    'assistant_staff_pops_returns_due',
    'assistant_staff_pops_topups_and_withdrawals_waiting',
    'assistant_staff_fops_disbursements',
    'assistant_staff_fops_merchant_cashouts',
    'assistant_staff_insight_desk_wait_times',
    'assistant_staff_insight_collection_coverage_trends',
    'assistant_staff_insight_calling_reach_and_themes',
    'assistant_staff_insight_payout_delays',
    'assistant_staff_insight_zoe_feedback_themes'
  ];
  v_missing_tables text[] := ARRAY[]::text[];
  v_missing_columns text[] := ARRAY[]::text[];
  v_missing_views text[] := ARRAY[]::text[];
  v_missing_functions text[] := ARRAY[]::text[];
  v_missing_all text[] := ARRAY[]::text[];
  v_item text;
  v_tbl text;
  v_col text;
  v_model_drift jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required for staff_assistant_health.'
      USING ERRCODE = '42501';
  END IF;

  FOREACH v_item IN ARRAY v_required_tables LOOP
    IF to_regclass('public.' || v_item) IS NULL THEN
      v_missing_tables := array_append(v_missing_tables, v_item);
      v_missing_all := array_append(v_missing_all, 'table:' || v_item);
    END IF;
  END LOOP;

  FOREACH v_item IN ARRAY v_required_columns LOOP
    v_tbl := split_part(v_item, '.', 1);
    v_col := split_part(v_item, '.', 2);
    IF NOT EXISTS (
      SELECT 1
        FROM information_schema.columns ic
       WHERE ic.table_schema = 'public'
         AND ic.table_name = v_tbl
         AND ic.column_name = v_col
    ) THEN
      v_missing_columns := array_append(v_missing_columns, v_item);
      v_missing_all := array_append(v_missing_all, 'column:' || v_item);
    END IF;
  END LOOP;

  FOREACH v_item IN ARRAY v_required_views LOOP
    IF to_regclass(v_item) IS NULL THEN
      v_missing_views := array_append(v_missing_views, v_item);
      v_missing_all := array_append(v_missing_all, 'view:' || v_item);
    END IF;
  END LOOP;

  FOREACH v_item IN ARRAY v_required_functions LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = v_item
    ) THEN
      v_missing_functions := array_append(v_missing_functions, v_item);
      v_missing_all := array_append(v_missing_all, 'function:' || v_item);
    END IF;
  END LOOP;

  v_model_drift := public.staff_assistant_check_model_drift(50);

  RETURN jsonb_build_object(
    'ok', (COALESCE(array_length(v_missing_all, 1), 0) = 0),
    'status', CASE
      WHEN COALESCE(array_length(v_missing_all, 1), 0) = 0 THEN 'ok'
      ELSE 'zoe_database_behind'
    END,
    'missing_count', COALESCE(array_length(v_missing_all, 1), 0),
    'missing_objects', to_jsonb(v_missing_all),
    'missing_tables', to_jsonb(v_missing_tables),
    'missing_columns', to_jsonb(v_missing_columns),
    'missing_views', to_jsonb(v_missing_views),
    'missing_functions', to_jsonb(v_missing_functions),
    'model_drift', v_model_drift,
    'checked_at', now()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_health() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_health() TO authenticated;

-- 3. Update staff_assistant_real_use_dashboard(p_days) to include model_drift and unified top-level metrics
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

  SELECT
    count(DISTINCT m.user_id) FILTER (WHERE m.created_at >= v_today_start),
    count(DISTINCT m.user_id) FILTER (WHERE m.created_at >= v_since_7d)
  INTO v_daily_active, v_weekly_active
  FROM public.staff_assistant_messages m
  WHERE m.role = 'assistant'
    AND m.created_at >= LEAST(v_since, v_since_7d);

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
