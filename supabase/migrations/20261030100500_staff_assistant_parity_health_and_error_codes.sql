-- =============================================================================
-- Migration: 20261030100000_staff_assistant_parity_health_and_error_codes.sql
-- Purpose:   Zoe World-Class Assistant — Prompt 1
--            ("Make Zoe work, and never again ship code ahead of its database"):
--              1. Extend `public.staff_assistant_unanswered` with `error_code`
--                 and `error_detail` (idempotent `ADD COLUMN IF NOT EXISTS`) so
--                 every degraded or failed optional dependency logs a stable,
--                 machine-readable error code and diagnostic detail.
--              2. Create `public.staff_assistant_get_config()` (`STABLE SECURITY
--                 DEFINER SET search_path = public`, caller-checked, granted to
--                 `authenticated` only) returning the authoritative Zoe runtime
--                 configuration row with safe defaults.
--              3. Create `public.assistant_staff_get_data_catalog(p_area text)`
--                 (`STABLE SECURITY DEFINER SET search_path = public`, caller-
--                 and role-checked, granted to `authenticated` only) as the
--                 canonical catalog RPC alias alongside `assistant_staff_data_catalog`,
--                 and register both in `staff_assistant_can_user_read_report`.
--              4. Create read-only `public.staff_assistant_health()` (`STABLE
--                 SECURITY DEFINER SET search_path = public`, caller-checked,
--                 granted to `authenticated` only) checking that every required
--                 Zoe table, column, `zoe_ro` view, and RPC exists in the live
--                 database and returning `status: 'ok' | 'zoe_database_behind'`
--                 with any missing object names.
--              5. Create admin/CRM-only `public.staff_assistant_error_summary(p_days integer)`
--                 (`STABLE SECURITY DEFINER SET search_path = public`, caller-
--                 and role-checked, granted to `authenticated` only) returning
--                 error counts grouped by `error_code` and Kampala day with zero
--                 user question or answer text.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Add `error_code` and `error_detail` to `public.staff_assistant_unanswered`
-- -----------------------------------------------------------------------------
ALTER TABLE public.staff_assistant_unanswered
  ADD COLUMN IF NOT EXISTS error_code text
    CONSTRAINT staff_assistant_unanswered_error_code_chk
    CHECK (error_code IS NULL OR char_length(btrim(error_code)) BETWEEN 2 AND 80),
  ADD COLUMN IF NOT EXISTS error_detail text
    CONSTRAINT staff_assistant_unanswered_error_detail_chk
    CHECK (error_detail IS NULL OR char_length(error_detail) <= 1000);

COMMENT ON COLUMN public.staff_assistant_unanswered.error_code IS
  'Stable machine-readable error code when an optional Zoe dependency or tool RPC fails (e.g. ERR_DB_CONFIG_MISSING, ERR_DB_GLOSSARY_MISSING, ERR_DB_TOOL_RPC_FAILED).';

COMMENT ON COLUMN public.staff_assistant_unanswered.error_detail IS
  'Redacted diagnostic detail (RPC or table name and Postgres error code/message; never user PII or figures).';

CREATE INDEX IF NOT EXISTS idx_staff_assistant_unanswered_error_code_created
  ON public.staff_assistant_unanswered (error_code, created_at DESC)
  WHERE error_code IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. Read-only configuration RPC: `public.staff_assistant_get_config()`
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_get_config()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_row record;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized: staff assistant access required for staff_assistant_get_config.'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    COALESCE(c.enabled, true) AS enabled,
    COALESCE(c.max_questions_per_day, 50) AS max_questions_per_day,
    COALESCE(c.max_emails_per_day, 30) AS max_emails_per_day,
    COALESCE(c.history_days, 90) AS history_days,
    COALESCE(c.max_model_rounds, 4) AS max_model_rounds,
    COALESCE(c.max_tool_calls, 6) AS max_tool_calls,
    COALESCE(c.max_notifications_per_day, 30) AS max_notifications_per_day,
    COALESCE(NULLIF(btrim(c.model_fast), ''), 'google/gemini-2.5-flash') AS model_fast,
    COALESCE(NULLIF(btrim(c.model_deep), ''), 'google/gemini-2.5-pro') AS model_deep,
    COALESCE(c.temperature, 0.20) AS temperature,
    COALESCE(c.max_tokens, 3200) AS max_tokens,
    COALESCE(c.max_deep_model_rounds, 8) AS max_deep_model_rounds,
    COALESCE(c.max_deep_tool_calls, 12) AS max_deep_tool_calls,
    COALESCE(c.max_cost_usd_per_question, 0.0800) AS max_cost_usd_per_question,
    COALESCE(c.web_research_enabled, false) AS web_research_enabled,
    c.updated_at
  INTO v_row
  FROM public.staff_assistant_config c
  WHERE c.id = true
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'enabled', true,
      'max_questions_per_day', 50,
      'max_emails_per_day', 30,
      'history_days', 90,
      'max_model_rounds', 4,
      'max_tool_calls', 6,
      'max_notifications_per_day', 30,
      'model_fast', 'google/gemini-2.5-flash',
      'model_deep', 'google/gemini-2.5-pro',
      'temperature', 0.20,
      'max_tokens', 3200,
      'max_deep_model_rounds', 8,
      'max_deep_tool_calls', 12,
      'max_cost_usd_per_question', 0.0800,
      'web_research_enabled', false
    );
  END IF;

  RETURN to_jsonb(v_row);
END;
$function$;

COMMENT ON FUNCTION public.staff_assistant_get_config() IS
  'Read-only RPC returning Zoe runtime configuration with safe defaults for authenticated staff.';

REVOKE ALL ON FUNCTION public.staff_assistant_get_config() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_get_config() TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Canonical Data Catalog RPC: `public.assistant_staff_get_data_catalog(p_area)`
--    (Delegates to `public.assistant_staff_data_catalog(p_area)` with full caller
--    and role checks so both names work identically.)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_get_data_catalog(
  p_area text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() OR NOT (
    public.can_view_staff_reports(v_uid) OR public.can_view_finance_reports(v_uid)
  ) THEN
    RAISE EXCEPTION 'Not authorized: staff assistant report access required for assistant_staff_get_data_catalog.'
      USING ERRCODE = '42501';
  END IF;

  RETURN public.assistant_staff_data_catalog(p_area);
END;
$function$;

COMMENT ON FUNCTION public.assistant_staff_get_data_catalog(text) IS
  'Read-only Zoe tool RPC returning the approved zoe_ro view catalog for the caller''s role areas.';

REVOKE ALL ON FUNCTION public.assistant_staff_get_data_catalog(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_get_data_catalog(text) TO authenticated;

-- Ensure `staff_assistant_can_user_read_report` recognizes both `assistant_staff_data_catalog`
-- Ensure `public.staff_assistant_can_user_read_report` is a single canonical
-- signature `(p_user_id uuid, p_report_rpc text, p_owner_id uuid DEFAULT NULL)`
-- (dropping the 2-arg overload from 20261028180000 so 2-arg and 3-arg callers
-- never hit Postgres overload ambiguity) and authorizes `assistant_staff_run_query`
-- and `assistant_staff_get_data_catalog`.
DROP FUNCTION IF EXISTS public.staff_assistant_can_user_read_report(uuid, text);

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
  v_rpc text := lower(btrim(COALESCE(p_report_rpc, '')));
  v_is_calling_member boolean;
BEGIN
  IF p_user_id IS NULL OR v_rpc = '' THEN
    RETURN false;
  END IF;

  IF NOT public._has_enabled_role(
    p_user_id,
    ARRAY[
      'employee', 'operations', 'tenant_ops', 'agent_ops', 'landlord_ops',
      'partner_ops', 'financial_ops', 'crm', 'hr', 'manager',
      'cfo', 'coo', 'ceo', 'cto', 'admin', 'super_admin'
    ]
  ) THEN
    RETURN false;
  END IF;

  IF v_rpc LIKE 'assistant_staff_my_%' THEN
    IF p_owner_id IS NOT NULL AND p_user_id <> p_owner_id THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;

  IF v_rpc IN (
    'assistant_staff_welile_glossary',
    'assistant_staff_get_glossary',
    'assistant_staff_data_catalog',
    'assistant_staff_get_data_catalog'
  ) THEN
    RETURN true;
  END IF;

  IF v_rpc LIKE 'assistant_staff_tops_%'
     OR v_rpc = 'assistant_staff_insight_desk_wait_times' THEN
    RETURN public.can_view_staff_reports(p_user_id)
      AND (
        public.is_ops_role(p_user_id)
        OR public._has_enabled_role(
          p_user_id,
          ARRAY['tenant_ops', 'operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
        )
      );
  END IF;

  IF v_rpc LIKE 'assistant_staff_lops_%' THEN
    RETURN public.can_view_staff_reports(p_user_id)
      AND (
        public.is_ops_role(p_user_id)
        OR public._has_enabled_role(
          p_user_id,
          ARRAY['landlord_ops', 'operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
        )
      );
  END IF;

  IF v_rpc LIKE 'assistant_staff_aops_%'
     OR v_rpc = 'assistant_staff_insight_collection_coverage_trends' THEN
    RETURN public.can_view_staff_reports(p_user_id)
      AND public._has_enabled_role(
        p_user_id,
        ARRAY['agent_ops', 'tenant_ops', 'operations', 'coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin']
      );
  END IF;

  IF v_rpc LIKE 'assistant_staff_pops_%' THEN
    RETURN public.can_view_staff_reports(p_user_id)
      AND public._has_enabled_role(
        p_user_id,
        ARRAY['partner_ops', 'financial_ops', 'cfo', 'ceo', 'coo', 'manager', 'super_admin']
      );
  END IF;

  IF v_rpc = 'assistant_staff_pso_cohort_performance' THEN
    RETURN public.can_view_staff_reports(p_user_id)
      AND public._has_enabled_role(
        p_user_id,
        ARRAY['hr', 'coo', 'ceo', 'super_admin']
      );
  END IF;

  IF v_rpc IN (
    'assistant_staff_cfo_treasury_cash_position',
    'assistant_staff_cfo_receivables_and_payables',
    'assistant_staff_cfo_seven_day_expenses',
    'assistant_staff_insight_payout_delays'
  ) THEN
    RETURN public.can_view_finance_reports(p_user_id)
      AND public._has_enabled_role(
        p_user_id,
        ARRAY['cfo', 'ceo', 'coo', 'manager', 'financial_ops', 'cto', 'super_admin']
      );
  END IF;

  IF v_rpc = 'assistant_staff_cfo_money_flow_summary' THEN
    RETURN public.can_view_finance_reports(p_user_id)
      AND public._has_enabled_role(
        p_user_id,
        ARRAY['cfo', 'ceo', 'super_admin']
      );
  END IF;

  IF v_rpc = 'assistant_staff_cfo_budget_revised_position' THEN
    RETURN public.can_view_finance_reports(p_user_id)
      AND public._has_enabled_role(
        p_user_id,
        ARRAY['cfo', 'ceo', 'coo', 'super_admin']
      );
  END IF;

  IF v_rpc LIKE 'assistant_staff_fops_%' THEN
    RETURN public.can_view_finance_reports(p_user_id)
      AND public._has_enabled_role(
        p_user_id,
        ARRAY['financial_ops', 'cfo', 'ceo', 'coo', 'super_admin']
      );
  END IF;

  IF v_rpc IN ('assistant_staff_coo_overview', 'assistant_staff_ceo_growth_and_approvals') THEN
    RETURN public.can_view_staff_reports(p_user_id)
      AND public._has_enabled_role(
        p_user_id,
        ARRAY['coo', 'ceo', 'cfo', 'manager', 'super_admin']
      );
  END IF;

  IF v_rpc IN (
    'assistant_staff_hr_calling_detailed_report',
    'assistant_staff_insight_calling_reach_and_themes'
  ) THEN
    v_is_calling_member := p_user_id IN (
      '5295252d-f477-42a9-92f5-af56e503e33d'::uuid,
      'a9258d45-3e27-4827-af71-64344e76fb4f'::uuid,
      'fda0d518-98c4-45e4-83d8-64266b25eefa'::uuid,
      'fe1e9f51-a2c3-49fc-bd40-b2c143afe628'::uuid
    );
    RETURN public.can_view_staff_reports(p_user_id)
      AND (
        v_is_calling_member
        OR public._has_enabled_role(
          p_user_id,
          ARRAY['hr', 'coo', 'cfo', 'ceo', 'manager', 'operations', 'super_admin']
        )
      );
  END IF;

  IF v_rpc IN (
    'assistant_staff_hr_contracts_and_birthdays',
    'assistant_staff_hr_payroll_cost_by_department'
  ) THEN
    RETURN public.can_view_staff_reports(p_user_id)
      AND public._has_enabled_role(
        p_user_id,
        ARRAY['hr', 'coo', 'ceo', 'cfo', 'super_admin']
      );
  END IF;

  IF v_rpc = 'assistant_staff_insight_zoe_feedback_themes' THEN
    RETURN public.can_view_staff_reports(p_user_id)
      AND public._has_enabled_role(
        p_user_id,
        ARRAY['crm', 'cto', 'coo', 'ceo', 'cfo', 'hr', 'manager', 'super_admin']
      );
  END IF;

  RETURN false;
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_assistant_can_user_read_report(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_can_user_read_report(uuid, text, uuid) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. Read-only Database Parity Health Check: `public.staff_assistant_health()`
--    Called by the edge function on startup (cached 60 seconds) and by
--    `scripts/guard-zoe-parity.mjs --check-live`.
-- -----------------------------------------------------------------------------
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
    'staff_assistant_queries'
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
    'staff_assistant_messages.hidden_by_user',
    'staff_assistant_feedback.report_kind',
    'staff_assistant_unanswered.error_code',
    'staff_assistant_unanswered.error_detail'
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
    'zoe_ro.landlords_payouts_summary'
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
    'assistant_staff_get_glossary',
    'assistant_staff_data_catalog',
    'assistant_staff_get_data_catalog',
    'assistant_staff_run_query',
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
    'checked_at', now()
  );
END;
$function$;

COMMENT ON FUNCTION public.staff_assistant_health() IS
  'Read-only parity health check returning status = ok or zoe_database_behind with any missing Zoe tables, columns, views, or RPCs.';

REVOKE ALL ON FUNCTION public.staff_assistant_health() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_health() TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. Admin / CRM Error Summary RPC: `public.staff_assistant_error_summary(p_days)`
--    Prompt 1 item (5):
--      "Add an admin-only staff_assistant_error_summary(p_days integer default 14)
--       RPC (counts by error_code and day, no user text) and show it on the
--       CRM review page."
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_error_summary(
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
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 14), 1), 90);
  v_from date := v_today - (v_days - 1);
  v_start timestamptz := (v_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_by_code_and_day jsonb := '[]'::jsonb;
  v_by_code_totals jsonb := '[]'::jsonb;
  v_total_errors integer := 0;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT (
       public.staff_assistant_crm_can_review()
       OR public._has_enabled_role(
         v_uid,
         ARRAY['crm', 'cto', 'coo', 'ceo', 'cfo', 'hr', 'manager', 'super_admin', 'access_admin']
       )
     )
  THEN
    RAISE EXCEPTION 'Not authorized: staff_assistant_error_summary is restricted to CRM reviewers and admins.'
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::integer
    INTO v_total_errors
    FROM public.staff_assistant_unanswered u
   WHERE u.created_at >= v_start
     AND (u.error_code IS NOT NULL OR u.reason = 'error');

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'day', d.kampala_day,
        'error_code', d.code_label,
        'reason', d.reason_label,
        'error_count', d.cnt
      )
      ORDER BY d.kampala_day DESC, d.cnt DESC, d.code_label ASC
    ),
    '[]'::jsonb
  )
  INTO v_by_code_and_day
  FROM (
    SELECT
      (u.created_at AT TIME ZONE 'Africa/Kampala')::date AS kampala_day,
      COALESCE(NULLIF(btrim(u.error_code), ''), 'ERR_UNSPECIFIED') AS code_label,
      COALESCE(u.reason, 'error') AS reason_label,
      count(*)::integer AS cnt
    FROM public.staff_assistant_unanswered u
    WHERE u.created_at >= v_start
      AND (u.error_code IS NOT NULL OR u.reason = 'error')
    GROUP BY
      (u.created_at AT TIME ZONE 'Africa/Kampala')::date,
      COALESCE(NULLIF(btrim(u.error_code), ''), 'ERR_UNSPECIFIED'),
      COALESCE(u.reason, 'error')
    ORDER BY
      (u.created_at AT TIME ZONE 'Africa/Kampala')::date DESC,
      count(*) DESC
    LIMIT 200
  ) d;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'error_code', t.code_label,
        'total_count', t.total_cnt,
        'last_seen_day', t.last_day
      )
      ORDER BY t.total_cnt DESC, t.code_label ASC
    ),
    '[]'::jsonb
  )
  INTO v_by_code_totals
  FROM (
    SELECT
      COALESCE(NULLIF(btrim(u.error_code), ''), 'ERR_UNSPECIFIED') AS code_label,
      count(*)::integer AS total_cnt,
      max((u.created_at AT TIME ZONE 'Africa/Kampala')::date) AS last_day
    FROM public.staff_assistant_unanswered u
    WHERE u.created_at >= v_start
      AND (u.error_code IS NOT NULL OR u.reason = 'error')
    GROUP BY COALESCE(NULLIF(btrim(u.error_code), ''), 'ERR_UNSPECIFIED')
    ORDER BY count(*) DESC
    LIMIT 50
  ) t;

  RETURN jsonb_build_object(
    'window_days', v_days,
    'from_date', v_from,
    'to_date', v_today,
    'total_errors', COALESCE(v_total_errors, 0),
    'by_code_totals', v_by_code_totals,
    'by_code_and_day', v_by_code_and_day
  );
END;
$function$;

COMMENT ON FUNCTION public.staff_assistant_error_summary(integer) IS
  'Admin/CRM-only summary of Zoe error counts grouped by error_code and Kampala day (never returns user question or answer text).';

REVOKE ALL ON FUNCTION public.staff_assistant_error_summary(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.staff_assistant_error_summary(integer) TO authenticated;

COMMIT;
