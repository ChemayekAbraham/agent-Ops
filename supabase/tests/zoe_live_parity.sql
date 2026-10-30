-- =============================================================================
-- Verification Suite: supabase/tests/zoe_live_parity.sql
-- Purpose:            Passes ONLY when every table, column, zoe_ro view, RPC,
--                     RPC signature, table grant, function grant, and
--                     mfa_required_for_staff restrictive policy required by
--                     Zoe exists in the target database.
--                     Read-only verification wrapped in BEGIN ... ROLLBACK.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_tbl text;
  v_col_spec text;
  v_col_tbl text;
  v_col_name text;
  v_view text;
  v_fn_sig text;
  v_fn_oid oid;
  v_tables constant text[] := ARRAY[
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
  v_select_only_tables constant text[] := ARRAY[
    'staff_assistant_config',
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
  v_columns constant text[] := ARRAY[
    'staff_assistant_config.id',
    'staff_assistant_config.enabled',
    'staff_assistant_config.max_questions_per_day',
    'staff_assistant_config.max_emails_per_day',
    'staff_assistant_config.history_days',
    'staff_assistant_config.max_model_rounds',
    'staff_assistant_config.max_tool_calls',
    'staff_assistant_config.max_notifications_per_day',
    'staff_assistant_config.model_fast',
    'staff_assistant_config.model_deep',
    'staff_assistant_config.temperature',
    'staff_assistant_config.max_tokens',
    'staff_assistant_config.max_deep_model_rounds',
    'staff_assistant_config.max_deep_tool_calls',
    'staff_assistant_config.max_cost_usd_per_question',
    'staff_assistant_config.web_research_enabled',
    'staff_assistant_conversations.hidden_by_user',
    'staff_assistant_conversations.hidden_at',
    'staff_assistant_conversations.created_at',
    'staff_assistant_conversations.last_message_at',
    'staff_assistant_conversations.updated_at',
    'staff_assistant_conversations.rolling_summary',
    'staff_assistant_messages.hidden_by_user',
    'staff_assistant_messages.hidden_at',
    'staff_assistant_feedback.report_kind',
    'staff_assistant_unanswered.error_code',
    'staff_assistant_unanswered.error_detail',
    'staff_assistant_notes.note_text',
    'staff_assistant_notes.is_deleted',
    'staff_assistant_glossary.slug',
    'staff_assistant_glossary.term',
    'staff_assistant_glossary.plain_definition',
    'staff_assistant_glossary.measurement_gotcha',
    'staff_assistant_data_catalog.view_name',
    'staff_assistant_data_catalog.role_area',
    'staff_assistant_data_catalog.requires_aal2',
    'staff_assistant_queries.sql_text',
    'staff_assistant_queries.executed_sql',
    'staff_assistant_queries.role_areas'
  ];
  v_views constant text[] := ARRAY[
    'public.v_staff_assistant_crm_messages_redacted',
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
  v_cron_only_functions constant text[] := ARRAY[
    'public.staff_assistant_purge_old_history()'
  ];
  v_service_role_functions constant text[] := ARRAY[
    'public.staff_assistant_check_question_rate_limit(uuid)',
    'public.staff_assistant_dispatch_due_reminders()',
    'public.staff_assistant_check_owner_access(uuid)',
    'public.staff_assistant_run_scheduled_report_as_owner(uuid, text, jsonb)'
  ];
  v_functions constant text[] := ARRAY[
    'public.staff_assistant_has_access()',
    'public.staff_assistant_require_staff()',
    'public.staff_assistant_email_recipients(text)',
    'public.staff_assistant_is_staff_email(text)',
    'public.staff_assistant_get_config()',
    'public.staff_assistant_health()',
    'public.staff_assistant_error_summary(integer)',
    'public.staff_assistant_can_user_read_report(uuid, text, uuid)',
    'public.staff_assistant_save_draft(text, jsonb, uuid)',
    'public.staff_assistant_consume_draft(uuid, text, jsonb)',
    'public.staff_assistant_check_email_budget(uuid, integer)',
    'public.staff_assistant_hide_my_history(uuid, uuid)',
    'public.staff_assistant_is_crm_reviewer()',
    'public.staff_assistant_crm_review_dashboard(text, boolean, boolean, text, integer, integer)',
    'public.staff_assistant_crm_conversation_thread(uuid)',
    'public.staff_assistant_crm_weekly_learning_report(integer, text)',
    'public.staff_assistant_rename_conversation(uuid, text)',
    'public.staff_assistant_create_reminder(text, timestamptz, text, uuid, uuid)',
    'public.staff_assistant_cancel_reminder(uuid)',
    'public.staff_assistant_send_colleague_notification(text, text, text, text, uuid, uuid)',
    'public.staff_assistant_compute_next_run(text, text, integer, timestamptz)',
    'public.staff_assistant_create_schedule(text, text, text, jsonb, text, text[], integer, text, text, uuid, uuid)',
    'public.staff_assistant_confirm_schedule_mfa(uuid)',
    'public.staff_assistant_cancel_schedule(uuid)',
    'public.staff_assistant_set_morning_brief_prefs(boolean, text, boolean)',
    'public.staff_assistant_can_manage_ideas(uuid)',
    'public.staff_assistant_save_idea(text, text, text, jsonb, text, text, text, text, uuid, uuid, uuid)',
    'public.staff_assistant_list_ideas(text, integer)',
    'public.staff_assistant_update_idea_status(uuid, text, text)',
    'public.staff_assistant_weekly_look_at_summary(date)',
    'public.staff_assistant_weekly_unanswered_list(integer)',
    'public.staff_assistant_refresh_daily_insights(date)',
    'public.zoe_glossary_can_manage(uuid)',
    'public.zoe_glossary_upsert_entry(text, text, text, text, text, text, text, text[], boolean)',
    'public.assistant_staff_my_profile()',
    'public.assistant_staff_my_payslips()',
    'public.assistant_staff_my_tasks(text)',
    'public.assistant_staff_my_tickets()',
    'public.assistant_staff_my_requisitions()',
    'public.assistant_staff_my_advances()',
    'public.assistant_staff_my_pending_concerns()',
    'public.assistant_staff_my_canteen(date)',
    'public.assistant_staff_my_wallet()',
    'public.assistant_staff_my_reminders_and_schedules(boolean)',
    'public.assistant_staff_my_calls(date, date)',
    'public.assistant_staff_tops_first_seven_summary(date, date, text)',
    'public.assistant_staff_tops_arrears_ageing(date, text, integer, integer, text)',
    'public.assistant_staff_tops_landlord_not_paid(date, integer, integer)',
    'public.assistant_staff_tops_tenant_classification()',
    'public.assistant_staff_tops_smartphone_usage(date, date)',
    'public.assistant_staff_tops_weekly_performance(date)',
    'public.assistant_staff_tops_no_payment_report(integer)',
    'public.assistant_staff_tops_rent_request_lifetime()',
    'public.assistant_staff_tops_rent_requests_by_stage(date, date)',
    'public.assistant_staff_tops_time_on_desk(text, integer)',
    'public.assistant_staff_tops_find_tenant(text, integer)',
    'public.assistant_staff_tops_awareness_calls(date, date)',
    'public.assistant_staff_lops_home_range(date, date)',
    'public.assistant_staff_lops_paid_lists(text, text, integer, integer)',
    'public.assistant_staff_lops_principal_comparison(date, date)',
    'public.assistant_staff_lops_calling_summary(date, date, date)',
    'public.assistant_staff_lops_calling_coverage(timestamptz)',
    'public.assistant_staff_lops_verification_queue(integer)',
    'public.assistant_staff_aops_network_overview(date, date, numeric)',
    'public.assistant_staff_aops_metrics_totals(date, date)',
    'public.assistant_staff_aops_metrics_agents(date, date, text, text, text, integer)',
    'public.assistant_staff_aops_listing_quality_and_risk(date, date, integer)',
    'public.assistant_staff_aops_silent_collectors(integer, integer)',
    'public.assistant_staff_aops_subagent_teams(date, date, integer)',
    'public.assistant_staff_pops_pending_summary(date)',
    'public.assistant_staff_pops_report_overview(date, date)',
    'public.assistant_staff_pops_search_supporters(text, integer)',
    'public.assistant_staff_pso_cohort_performance(date, date)',
    'public.assistant_staff_pops_returns_due(date, date)',
    'public.assistant_staff_pops_topups_and_withdrawals_waiting(integer)',
    'public.assistant_staff_cfo_treasury_cash_position(timestamptz)',
    'public.assistant_staff_cfo_money_flow_summary()',
    'public.assistant_staff_cfo_receivables_and_payables(text, integer, date)',
    'public.assistant_staff_cfo_seven_day_expenses()',
    'public.assistant_staff_cfo_budget_revised_position()',
    'public.assistant_staff_fops_verification_and_requisitions(date, date)',
    'public.assistant_staff_fops_disbursements(date, date)',
    'public.assistant_staff_fops_merchant_cashouts(date, date)',
    'public.assistant_staff_coo_overview(integer, date, date)',
    'public.assistant_staff_ceo_growth_and_approvals(integer)',
    'public.assistant_staff_hr_calling_detailed_report(date, date)',
    'public.assistant_staff_hr_contracts_and_birthdays(integer)',
    'public.assistant_staff_hr_payroll_cost_by_department(text)',
    'public.assistant_staff_insight_desk_wait_times(integer)',
    'public.assistant_staff_insight_collection_coverage_trends(integer)',
    'public.assistant_staff_insight_calling_reach_and_themes(date, date)',
    'public.assistant_staff_insight_payout_delays(integer)',
    'public.assistant_staff_insight_zoe_feedback_themes(integer)',
    'public.assistant_staff_get_glossary(text, text)',
    'public.assistant_staff_data_catalog(text)',
    'public.assistant_staff_get_data_catalog(text)',
    'public.assistant_staff_run_query(text, text)'
  ];
BEGIN
  -- 1. Check tables, RLS enabled, mfa_required_for_staff restrictive policy, and anon grants
  FOREACH v_tbl IN ARRAY v_tables LOOP
    IF to_regclass('public.' || v_tbl) IS NULL THEN
      v_missing := array_append(v_missing, 'missing_table:public.' || v_tbl);
    ELSE
      IF NOT EXISTS (
        SELECT 1
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = v_tbl
           AND c.relrowsecurity = true
      ) THEN
        v_missing := array_append(v_missing, 'rls_disabled:public.' || v_tbl);
      END IF;

      IF NOT EXISTS (
        SELECT 1
          FROM pg_policy pol
          JOIN pg_class c ON c.oid = pol.polrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = v_tbl
           AND pol.polname = 'mfa_required_for_staff'
           AND pol.polpermissive = false
      ) THEN
        v_missing := array_append(v_missing, 'missing_mfa_policy:public.' || v_tbl);
      END IF;

      IF has_table_privilege('anon', 'public.' || v_tbl, 'SELECT, INSERT, UPDATE, DELETE') THEN
        v_missing := array_append(v_missing, 'anon_has_privilege:public.' || v_tbl);
      END IF;
    END IF;
  END LOOP;

  -- 2. Check SELECT-only tables for authenticated
  FOREACH v_tbl IN ARRAY v_select_only_tables LOOP
    IF to_regclass('public.' || v_tbl) IS NOT NULL THEN
      IF has_table_privilege('authenticated', 'public.' || v_tbl, 'INSERT, UPDATE, DELETE') THEN
        v_missing := array_append(v_missing, 'authenticated_has_write_on_locked_table:public.' || v_tbl);
      END IF;
    END IF;
  END LOOP;

  -- 3. Check required columns
  FOREACH v_col_spec IN ARRAY v_columns LOOP
    v_col_tbl := split_part(v_col_spec, '.', 1);
    v_col_name := split_part(v_col_spec, '.', 2);
    IF NOT EXISTS (
      SELECT 1
        FROM information_schema.columns ic
       WHERE ic.table_schema = 'public'
         AND ic.table_name = v_col_tbl
         AND ic.column_name = v_col_name
    ) THEN
      v_missing := array_append(v_missing, 'missing_column:public.' || v_col_spec);
    END IF;
  END LOOP;

  -- 4. Check views
  FOREACH v_view IN ARRAY v_views LOOP
    IF to_regclass(v_view) IS NULL THEN
      v_missing := array_append(v_missing, 'missing_view:' || v_view);
    ELSE
      IF has_table_privilege('anon', v_view, 'SELECT') THEN
        v_missing := array_append(v_missing, 'anon_has_select_on_view:' || v_view);
      END IF;
      IF NOT has_table_privilege('authenticated', v_view, 'SELECT') THEN
        v_missing := array_append(v_missing, 'authenticated_missing_select_on_view:' || v_view);
      END IF;
    END IF;
  END LOOP;

  -- 5. Check functions & grants
  FOREACH v_fn_sig IN ARRAY v_functions LOOP
    v_fn_oid := to_regprocedure(v_fn_sig);
    IF v_fn_oid IS NULL THEN
      v_missing := array_append(v_missing, 'missing_function:' || v_fn_sig);
    ELSE
      IF has_function_privilege('anon', v_fn_oid, 'EXECUTE') THEN
        v_missing := array_append(v_missing, 'anon_has_execute:' || v_fn_sig);
      END IF;
      IF NOT has_function_privilege('authenticated', v_fn_oid, 'EXECUTE') THEN
        v_missing := array_append(v_missing, 'authenticated_missing_execute:' || v_fn_sig);
      END IF;
    END IF;
  END LOOP;

  -- 6. Check service_role-only functions
  FOREACH v_fn_sig IN ARRAY v_service_role_functions LOOP
    v_fn_oid := to_regprocedure(v_fn_sig);
    IF v_fn_oid IS NULL THEN
      v_missing := array_append(v_missing, 'missing_function:' || v_fn_sig);
    ELSE
      IF has_function_privilege('anon', v_fn_oid, 'EXECUTE') THEN
        v_missing := array_append(v_missing, 'anon_has_execute:' || v_fn_sig);
      END IF;
      IF NOT has_function_privilege('service_role', v_fn_oid, 'EXECUTE') THEN
        v_missing := array_append(v_missing, 'service_role_missing_execute:' || v_fn_sig);
      END IF;
    END IF;
  END LOOP;

  -- 7. Check cron/superuser-only functions
  FOREACH v_fn_sig IN ARRAY v_cron_only_functions LOOP
    v_fn_oid := to_regprocedure(v_fn_sig);
    IF v_fn_oid IS NULL THEN
      v_missing := array_append(v_missing, 'missing_function:' || v_fn_sig);
    ELSE
      IF has_function_privilege('anon', v_fn_oid, 'EXECUTE') THEN
        v_missing := array_append(v_missing, 'anon_has_execute:' || v_fn_sig);
      END IF;
      IF has_function_privilege('authenticated', v_fn_oid, 'EXECUTE') THEN
        v_missing := array_append(v_missing, 'authenticated_has_execute:' || v_fn_sig);
      END IF;
    END IF;
  END LOOP;

  IF COALESCE(array_length(v_missing, 1), 0) > 0 THEN
    RAISE EXCEPTION 'zoe_database_behind (% violations): %',
      array_length(v_missing, 1),
      array_to_string(v_missing, ', ');
  END IF;
END;
$$;

ROLLBACK;
