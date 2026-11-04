-- =============================================================================
-- Verification Suite: supabase/tests/zoe_live_parity.sql
-- Purpose:            Passes ONLY when:
--                       1. Every table, column, zoe_ro view, RPC, RPC signature,
--                          table grant, function grant, and mfa_required_for_staff
--                          restrictive policy required by Zoe exists in the target
--                          database.
--                       2. Every zoe_ro.* view has security_invoker = true.
--                       3. NO untracked staff_assistant_* or assistant_staff_*
--                          table/function or zoe_ro.* view exists live without a
--                          matching definition in the committed migration manifest
--                          (reverse drift guard).
--                       4. supabase_migrations.schema_migrations records the
--                          consolidated Zoe migration versions.
--                     Read-only verification wrapped in BEGIN ... ROLLBACK.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_drift text[] := ARRAY[]::text[];
  v_tbl text;
  v_col_spec text;
  v_col_tbl text;
  v_col_name text;
  v_view text;
  v_fn_sig text;
  v_fn_oid oid;
  v_live_name text;
  v_mig_ver text;
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
    'staff_assistant_queries',
    'staff_assistant_research_logs',
    'staff_assistant_learning_log',
    'staff_assistant_eval_candidates',
    'staff_assistant_knowledge_base',
    'staff_assistant_projects',
    'staff_assistant_uploads',
    'staff_assistant_kb_zero_hits'
  ];
  v_select_only_tables constant text[] := ARRAY[
    'staff_assistant_config',
    'staff_assistant_reminders',
    'staff_assistant_schedules',
    'staff_assistant_drafts',
    'staff_assistant_insights',
    'staff_assistant_ideas',
    'staff_assistant_notes',
    'staff_assistant_glossary',
    'staff_assistant_data_catalog',
    'staff_assistant_queries',
    'staff_assistant_research_logs'
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
    'staff_assistant_conversations.project_id',
    'staff_assistant_messages.hidden_by_user',
    'staff_assistant_messages.hidden_at',
    'staff_assistant_messages.requested_model',
    'staff_assistant_messages.gateway_model',
    'staff_assistant_messages.ttfb_ms',
    'staff_assistant_messages.error_code',
    'staff_assistant_messages.cost_usd',
    'staff_assistant_messages.analyst_used',
    'staff_assistant_messages.research_used',
    'staff_assistant_feedback.report_kind',
    'staff_assistant_unanswered.error_code',
    'staff_assistant_unanswered.error_detail',
    'staff_assistant_unanswered.routed_department',
    'staff_assistant_unanswered.taught_knowledge_id',
    'staff_assistant_unanswered.taught_by_name',
    'staff_assistant_unanswered.taught_at',
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
    'staff_assistant_queries.role_areas',
    'staff_assistant_knowledge_base.department',
    'staff_assistant_knowledge_base.created_by',
    'staff_assistant_knowledge_base.approved_by',
    'staff_assistant_knowledge_base.reviewed_by_name',
    'staff_assistant_knowledge_base.expires_at',
    'staff_assistant_preferences.web_push_enabled',
    'staff_assistant_preferences.web_push_morning_brief_topic',
    'staff_assistant_preferences.web_push_taught_updates_topic',
    'staff_assistant_preferences.voice_disclosure_acknowledged_at',
    'staff_assistant_projects.pinned_file_ids',
    'staff_assistant_uploads.extracted_summary'
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
    'zoe_ro.landlords_payouts_summary',
    'zoe_ro.calling_my_space_officer_daily',
    'zoe_ro.tenants_directory_by_stage_and_location',
    'zoe_ro.operations_desk_turnaround_summary',
    'zoe_ro.tenants_first_seven_days_cohort'
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
    'public.staff_assistant_check_model_drift(integer)',
    'public.staff_assistant_error_summary(integer)',
    'public.staff_assistant_real_use_dashboard(integer)',
    'public.staff_assistant_can_user_read_report(uuid, text, uuid)',
    'public.staff_assistant_save_draft(text, jsonb, uuid)',
    'public.staff_assistant_consume_draft(uuid, text, jsonb)',
    'public.staff_assistant_check_email_budget(uuid, integer)',
    'public.staff_assistant_hide_my_history(uuid, uuid)',
    'public.staff_assistant_upsert_project(uuid, text, text, uuid[])',
    'public.staff_assistant_list_projects()',
    'public.staff_assistant_delete_project(uuid)',
    'public.staff_assistant_purge_expired_uploads()',
    'public.staff_assistant_department_teaching_queue(text, text, integer)',
    'public.staff_assistant_teach_from_review_queue(uuid, text, text, text, text, text, text, text, text, text, text[], text[])',
    'public.staff_assistant_role_goals_and_measures(integer)',
    'public.staff_assistant_can_send_web_push(uuid, text)',
    'public.staff_assistant_update_push_and_voice_prefs(boolean, boolean, boolean, boolean, boolean)',
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
    'public.zoe_ro_validate_query(text)',
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
    'public.assistant_staff_my_work_summary(date, date)',
    'public.assistant_staff_team_work_summary(text, date, date)',
    'public.assistant_staff_my_taught_updates()',
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
    'public.assistant_staff_run_query(text, text)',
    'public.assistant_staff_search_knowledge_base(text, text, integer)',
    'public.assistant_staff_personalised_starters()',
    'public.assistant_staff_morning_brief_what_changed()'
  ];
  v_known_fn_names constant text[] := ARRAY[
    'staff_assistant_has_access',
    'staff_assistant_require_staff',
    'staff_assistant_purge_old_history',
    'staff_assistant_email_recipients',
    'staff_assistant_is_staff_email',
    'staff_assistant_can_view_pii',
    'staff_assistant_mask_phone',
    'staff_assistant_mask_nin',
    'staff_assistant_sanitize_jsonb',
    'staff_assistant_get_config',
    'staff_assistant_health',
    'staff_assistant_check_model_drift',
    'staff_assistant_error_summary',
    'staff_assistant_real_use_dashboard',
    'staff_assistant_can_user_read_report',
    'staff_assistant_save_draft',
    'staff_assistant_consume_draft',
    'staff_assistant_check_question_rate_limit',
    'staff_assistant_check_email_budget',
    'staff_assistant_hide_my_history',
    'staff_assistant_upsert_project',
    'staff_assistant_list_projects',
    'staff_assistant_delete_project',
    'staff_assistant_purge_expired_uploads',
    'staff_assistant_department_teaching_queue',
    'staff_assistant_teach_from_review_queue',
    'staff_assistant_role_goals_and_measures',
    'staff_assistant_can_send_web_push',
    'staff_assistant_update_push_and_voice_prefs',
    'staff_assistant_is_crm_reviewer',
    'staff_assistant_crm_review_dashboard',
    'staff_assistant_crm_conversation_thread',
    'staff_assistant_crm_weekly_learning_report',
    'staff_assistant_rename_conversation',
    'staff_assistant_create_reminder',
    'staff_assistant_cancel_reminder',
    'staff_assistant_dispatch_due_reminders',
    'staff_assistant_send_colleague_notification',
    'staff_assistant_compute_next_run',
    'staff_assistant_create_schedule',
    'staff_assistant_confirm_schedule_mfa',
    'staff_assistant_cancel_schedule',
    'staff_assistant_set_morning_brief_prefs',
    'staff_assistant_check_owner_access',
    'staff_assistant_run_scheduled_report_as_owner',
    'staff_assistant_can_manage_ideas',
    'staff_assistant_save_idea',
    'staff_assistant_list_ideas',
    'staff_assistant_update_idea_status',
    'staff_assistant_weekly_look_at_summary',
    'staff_assistant_weekly_unanswered_list',
    'staff_assistant_refresh_daily_insights',
    'staff_assistant_log_query',
    'staff_assistant_update_note',
    'staff_assistant_set_memory_prefs',
    'staff_assistant_get_memory_prefs',
    'staff_assistant_upsert_knowledge_entry',
    'staff_assistant_promote_to_eval_set',
    'staff_assistant_weekly_manager_learning_view',
    'staff_assistant_touch_updated_at',
    'staff_assistant_crm_can_review',
    'staff_assistant_redact_text',
    'staff_assistant_unanswered_ensure_error_code',
    'staff_assistant_enforce_upload_limits',
    'staff_assistant_check_web_research_budget',
    'staff_assistant_log_web_research',
    'staff_assistant_save_memory_note',
    'staff_assistant_delete_note',
    'staff_assistant_compute_draft_hash',
    'staff_assistant_is_valid_link_path',
    'staff_assistant_unanswered_stamp_review',
    'staff_assistant_write_or_read_roles_list',
    'assistant_staff_my_profile',
    'assistant_staff_my_payslips',
    'assistant_staff_my_tasks',
    'assistant_staff_my_tickets',
    'assistant_staff_my_requisitions',
    'assistant_staff_my_advances',
    'assistant_staff_my_pending_concerns',
    'assistant_staff_my_canteen',
    'assistant_staff_my_wallet',
    'assistant_staff_my_reminders_and_schedules',
    'assistant_staff_my_calls',
    'assistant_staff_my_work_summary',
    'assistant_staff_team_work_summary',
    'assistant_staff_my_taught_updates',
    'assistant_staff_tops_first_seven_summary',
    'assistant_staff_tops_arrears_ageing',
    'assistant_staff_tops_landlord_not_paid',
    'assistant_staff_tops_tenant_classification',
    'assistant_staff_tops_smartphone_usage',
    'assistant_staff_tops_weekly_performance',
    'assistant_staff_tops_no_payment_report',
    'assistant_staff_tops_rent_request_lifetime',
    'assistant_staff_tops_rent_requests_by_stage',
    'assistant_staff_tops_time_on_desk',
    'assistant_staff_tops_find_tenant',
    'assistant_staff_tops_awareness_calls',
    'assistant_staff_lops_home_range',
    'assistant_staff_lops_paid_lists',
    'assistant_staff_lops_principal_comparison',
    'assistant_staff_lops_calling_summary',
    'assistant_staff_lops_calling_coverage',
    'assistant_staff_lops_verification_queue',
    'assistant_staff_aops_network_overview',
    'assistant_staff_aops_metrics_totals',
    'assistant_staff_aops_metrics_agents',
    'assistant_staff_aops_listing_quality_and_risk',
    'assistant_staff_aops_silent_collectors',
    'assistant_staff_aops_subagent_teams',
    'assistant_staff_pops_pending_summary',
    'assistant_staff_pops_report_overview',
    'assistant_staff_pops_search_supporters',
    'assistant_staff_pso_cohort_performance',
    'assistant_staff_pops_returns_due',
    'assistant_staff_pops_topups_and_withdrawals_waiting',
    'assistant_staff_cfo_treasury_cash_position',
    'assistant_staff_cfo_money_flow_summary',
    'assistant_staff_cfo_receivables_and_payables',
    'assistant_staff_cfo_seven_day_expenses',
    'assistant_staff_cfo_budget_revised_position',
    'assistant_staff_fops_verification_and_requisitions',
    'assistant_staff_fops_disbursements',
    'assistant_staff_fops_merchant_cashouts',
    'assistant_staff_coo_overview',
    'assistant_staff_ceo_growth_and_approvals',
    'assistant_staff_hr_calling_detailed_report',
    'assistant_staff_hr_contracts_and_birthdays',
    'assistant_staff_hr_payroll_cost_by_department',
    'assistant_staff_insight_desk_wait_times',
    'assistant_staff_insight_collection_coverage_trends',
    'assistant_staff_insight_calling_reach_and_themes',
    'assistant_staff_insight_payout_delays',
    'assistant_staff_insight_zoe_feedback_themes',
    'assistant_staff_get_glossary',
    'assistant_staff_welile_glossary',
    'assistant_staff_data_catalog',
    'assistant_staff_get_data_catalog',
    'assistant_staff_run_query',
    'assistant_staff_search_knowledge_base',
    'assistant_staff_personalised_starters',
    'assistant_staff_morning_brief_what_changed',
    'assistant_staff_my_tasks_and_attendance',
    'assistant_staff_my_work_logs',
    'assistant_staff_my_concerns'
  ];
  v_required_migration_versions constant text[] := ARRAY[
    '20261031120000',
    '20261031140000',
    '20261031160000',
    '20261103180000'
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

  -- 4. Check views + security_invoker = true on all zoe_ro views
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
      IF v_view LIKE 'zoe_ro.%' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'zoe_ro'
            AND c.relname = split_part(v_view, '.', 2)
            AND 'security_invoker=true' = ANY(COALESCE(c.reloptions, ARRAY[]::text[]))
        ) THEN
          v_missing := array_append(v_missing, 'missing_security_invoker:' || v_view);
        END IF;
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

  -- 8. Check supabase_migrations.schema_migrations ledger for reconciled versions
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'supabase_migrations'
      AND table_name = 'schema_migrations'
  ) THEN
    FOREACH v_mig_ver IN ARRAY v_required_migration_versions LOOP
      IF NOT EXISTS (
        SELECT 1
        FROM supabase_migrations.schema_migrations sm
        WHERE sm.version = v_mig_ver
      ) THEN
        v_missing := array_append(v_missing, 'missing_schema_migration_version:' || v_mig_ver);
      END IF;
    END LOOP;
  END IF;

  -- 9. Reverse live drift check: fail if ANY staff_assistant_* or assistant_staff_*
  --    table/function or zoe_ro.* view exists live without being in the committed manifest
  FOR v_live_name IN
    SELECT ic.table_name
    FROM information_schema.tables ic
    WHERE ic.table_schema = 'public'
      AND ic.table_type = 'BASE TABLE'
      AND (ic.table_name LIKE 'staff_assistant_%' OR ic.table_name LIKE 'assistant_staff_%')
  LOOP
    IF NOT (v_live_name = ANY(v_tables)) THEN
      v_drift := array_append(v_drift, 'untracked_live_table:public.' || v_live_name);
    END IF;
  END LOOP;

  FOR v_live_name IN
    SELECT 'zoe_ro.' || c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'zoe_ro'
      AND c.relkind = 'v'
  LOOP
    IF NOT (v_live_name = ANY(v_views)) THEN
      v_drift := array_append(v_drift, 'untracked_live_view:' || v_live_name);
    END IF;
  END LOOP;

  FOR v_live_name IN
    SELECT DISTINCT p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (p.proname LIKE 'staff_assistant_%' OR p.proname LIKE 'assistant_staff_%')
  LOOP
    IF NOT (v_live_name = ANY(v_known_fn_names)) THEN
      v_drift := array_append(v_drift, 'untracked_live_function:public.' || v_live_name);
    END IF;
  END LOOP;

  IF COALESCE(array_length(v_missing, 1), 0) > 0 THEN
    RAISE EXCEPTION 'zoe_database_behind (% violations): %',
      array_length(v_missing, 1),
      array_to_string(v_missing, ', ');
  END IF;

  IF COALESCE(array_length(v_drift, 1), 0) > 0 THEN
    RAISE EXCEPTION 'zoe_live_untracked_drift (% violations): %',
      array_length(v_drift, 1),
      array_to_string(v_drift, ', ');
  END IF;
END;
$$;

ROLLBACK;
