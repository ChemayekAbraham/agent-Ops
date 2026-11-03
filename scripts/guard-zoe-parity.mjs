#!/usr/bin/env node
/**
 * CI & Deploy Guard — Zoe Database Parity & Reverse Drift Guard (`npm run guard:zoe-parity`).
 *
 * Prevents shipping Zoe edge-function or frontend code ahead of its database objects,
 * and prevents live database objects from existing without a matching committed migration:
 *   1. Maintains the canonical Zoe object manifest from `docs/zoe/parity-audit.md`
 *      (all 21 tables, columns, 23 views, RPCs, and RPC arguments).
 *   2. Verifies that every migration version prefix in `supabase/migrations/` is unique
 *      (no duplicate 14-digit timestamps).
 *   3. Scans `supabase/functions/staff-assistant*`, `src/components/zoe/`,
 *      `src/lib/zoe/`, and `src/hooks/useZoeCrm.ts` to verify that every
 *      `staff_assistant_*` / `assistant_staff_*` / `zoe_*` table, RPC, and RPC
 *      argument used in code is registered in the parity manifest and defined
 *      in `supabase/migrations/` with explicit grants and `mfa_required_for_staff`.
 *   4. Verifies reverse drift (`auditReverseLiveDrift`): fails if any `staff_assistant_*`
 *      or `assistant_staff_*` object or `zoe_ro.*` view exists live without a matching
 *      committed migration file in `supabase/migrations/`.
 *   5. Verifies that `supabase/functions/staff-assistant/` calls the cached
 *      (60-second TTL) `staff_assistant_health` RPC on startup and reports
 *      `"zoe_database_behind"` with the missing object names when behind.
 *
 * Usage:
 *   node scripts/guard-zoe-parity.mjs
 *   node scripts/guard-zoe-parity.mjs --self-test
 *   node scripts/guard-zoe-parity.mjs --check-live
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');

export const REQUIRED_ZOE_TABLES = [
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
  'staff_assistant_kb_zero_hits',
];

export const REQUIRED_ZOE_COLUMNS = {
  staff_assistant_config: [
    'id',
    'enabled',
    'max_questions_per_day',
    'max_emails_per_day',
    'history_days',
    'updated_at',
    'updated_by',
    'max_model_rounds',
    'max_tool_calls',
    'max_notifications_per_day',
    'model_fast',
    'model_deep',
    'temperature',
    'max_tokens',
    'max_deep_model_rounds',
    'max_deep_tool_calls',
    'max_cost_usd_per_question',
    'web_research_enabled',
  ],
  staff_assistant_conversations: [
    'id',
    'user_id',
    'persona',
    'title',
    'status',
    'started_at',
    'last_active_at',
    'closed_at',
    'message_count',
    'ip_address',
    'user_agent',
    'device_class',
    'device_browser',
    'device_os',
    'hidden_by_user',
    'hidden_at',
    'created_at',
    'last_message_at',
    'updated_at',
    'rolling_summary',
    'project_id',
  ],
  staff_assistant_messages: [
    'id',
    'conversation_id',
    'user_id',
    'role',
    'content',
    'outcome',
    'tools_called',
    'source_label',
    'period_label',
    'report_payload',
    'model',
    'requested_model',
    'gateway_model',
    'ttfb_ms',
    'latency_ms',
    'error_code',
    'cost_usd',
    'analyst_used',
    'research_used',
    'created_at',
    'hidden_by_user',
    'hidden_at',
  ],
  staff_assistant_feedback: [
    'id',
    'conversation_id',
    'message_id',
    'user_id',
    'rating',
    'comment',
    'created_at',
    'updated_at',
    'report_kind',
  ],
  staff_assistant_unanswered: [
    'id',
    'conversation_id',
    'message_id',
    'user_id',
    'caller_roles',
    'question_text',
    'reason',
    'status',
    'reviewed_by',
    'reviewed_at',
    'review_note',
    'created_at',
    'error_code',
    'error_detail',
    'routed_department',
    'taught_knowledge_id',
    'taught_by_name',
    'taught_at',
    'asker_notified_at',
    'asker_seen_at',
  ],
  staff_assistant_notes: [
    'id',
    'user_id',
    'note_text',
    'is_deleted',
    'created_at',
    'updated_at',
  ],
  staff_assistant_glossary: [
    'id',
    'slug',
    'term',
    'category',
    'plain_definition',
    'measurement_gotcha',
    'official_source',
    'screen_path',
    'keywords',
    'is_active',
    'updated_by',
    'created_at',
    'updated_at',
  ],
  staff_assistant_data_catalog: [
    'view_name',
    'role_area',
    'requires_aal2',
    'title',
    'description',
    'use_for',
    'do_not_use_for',
    'official_source',
    'columns',
    'created_at',
  ],
  staff_assistant_queries: [
    'id',
    'user_id',
    'question',
    'sql_text',
    'executed_sql',
    'role_areas',
    'row_count',
    'truncated',
    'duration_ms',
    'status',
    'error_message',
    'created_at',
  ],
  staff_assistant_preferences: [
    'user_id',
    'morning_brief_enabled',
    'morning_brief_time',
    'memory_enabled',
    'dismissed_memory_prompts',
    'web_push_enabled',
    'web_push_muted',
    'web_push_sent_today_count',
    'web_push_sent_kampala_date',
    'web_push_morning_brief_topic',
    'web_push_taught_updates_topic',
    'voice_disclosure_acknowledged_at',
    'has_completed_tour',
    'updated_at',
  ],
  staff_assistant_learning_log: [
    'id',
    'conversation_id',
    'message_id',
    'user_id',
    'caller_roles',
    'topic',
    'tool_used',
    'outcome',
    'requested_model',
    'gateway_model',
    'ttfb_ms',
    'latency_ms',
    'error_code',
    'cost_usd',
    'model_tier',
    'analyst_used',
    'research_used',
    'feedback_rating',
    'feedback_theme',
    'created_at',
  ],
  staff_assistant_eval_candidates: [
    'id',
    'source_kind',
    'source_id',
    'cleaned_question',
    'expected_topic',
    'expected_tool',
    'outcome_before',
    'reviewer_notes',
    'added_by',
    'is_active',
    'created_at',
    'updated_at',
  ],
  staff_assistant_knowledge_base: [
    'id',
    'slug',
    'title',
    'category',
    'department',
    'summary',
    'body',
    'measurement_gotcha',
    'official_source',
    'screen_path',
    'keywords',
    'synonyms',
    'review_status',
    'created_by',
    'approved_by',
    'reviewed_by',
    'reviewed_by_name',
    'reviewed_at',
    'expires_at',
    'usage_count',
    'last_used_at',
    'source_unanswered_id',
    'updated_by',
    'created_at',
    'updated_at',
  ],
  staff_assistant_projects: [
    'id',
    'user_id',
    'name',
    'instructions',
    'pinned_file_ids',
    'is_archived',
    'created_at',
    'updated_at',
  ],
  staff_assistant_uploads: [
    'id',
    'user_id',
    'conversation_id',
    'project_id',
    'storage_path',
    'file_name',
    'mime_type',
    'size_bytes',
    'extracted_summary',
    'has_pii_warning',
    'pii_warning_types',
    'expires_at',
    'created_at',
  ],
  staff_assistant_kb_zero_hits: [
    'id',
    'user_id',
    'caller_roles',
    'sanitized_query',
    'routed_department',
    'hit_count',
    'last_seen_at',
    'created_at',
  ],
};

export const REQUIRED_ZOE_VIEWS = [
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
  'zoe_ro.tenants_first_seven_days_cohort',
];

export const REQUIRED_ZOE_RPCS = {
  // Foundation, config, security, drafts, history, health & error summary
  staff_assistant_has_access: [],
  staff_assistant_require_staff: [],
  staff_assistant_purge_old_history: [],
  staff_assistant_email_recipients: ['p_search'],
  staff_assistant_is_staff_email: ['p_email'],
  staff_assistant_can_view_pii: ['p_scope'],
  staff_assistant_mask_phone: ['p_phone', 'p_allow_full'],
  staff_assistant_mask_nin: ['p_nin', 'p_allow_full'],
  staff_assistant_sanitize_jsonb: ['p_data', 'p_allow_phones', 'p_max_rows'],
  staff_assistant_get_config: [],
  staff_assistant_health: [],
  staff_assistant_error_summary: ['p_days'],
  staff_assistant_real_use_dashboard: ['p_days'],
  staff_assistant_can_user_read_report: ['p_user_id', 'p_report_rpc', 'p_owner_id'],
  staff_assistant_save_draft: ['p_kind', 'p_payload', 'p_conversation_id'],
  staff_assistant_consume_draft: ['p_draft_id', 'p_kind', 'p_payload'],
  staff_assistant_check_question_rate_limit: ['p_user_id'],
  staff_assistant_check_email_budget: ['p_user_id', 'p_recipient_count'],
  staff_assistant_hide_my_history: ['p_user_id', 'p_conversation_id'],
  // Projects & uploads
  staff_assistant_upsert_project: ['p_project_id', 'p_name', 'p_instructions', 'p_pinned_file_ids'],
  staff_assistant_list_projects: [],
  staff_assistant_delete_project: ['p_project_id'],
  staff_assistant_purge_expired_uploads: [],
  // Teaching loop, KB, role goals & push/voice consent
  staff_assistant_department_teaching_queue: ['p_department', 'p_status', 'p_limit'],
  staff_assistant_teach_from_review_queue: [
    'p_unanswered_id',
    'p_slug',
    'p_title',
    'p_category',
    'p_department',
    'p_summary',
    'p_body',
    'p_measurement_gotcha',
    'p_official_source',
    'p_screen_path',
    'p_keywords',
    'p_synonyms',
  ],
  staff_assistant_role_goals_and_measures: ['p_days'],
  staff_assistant_can_send_web_push: ['p_user_id', 'p_topic'],
  staff_assistant_update_push_and_voice_prefs: [
    'p_web_push_enabled',
    'p_web_push_muted',
    'p_morning_brief_topic',
    'p_taught_updates_topic',
    'p_acknowledge_voice_disclosure',
  ],
  // CRM review & weekly learning
  staff_assistant_is_crm_reviewer: [],
  staff_assistant_crm_review_dashboard: [
    'p_role_filter',
    'p_thumbs_down',
    'p_unanswered_only',
    'p_search',
    'p_days',
    'p_limit',
  ],
  staff_assistant_crm_conversation_thread: ['p_conversation_id'],
  staff_assistant_crm_weekly_learning_report: ['p_days', 'p_role_filter'],
  staff_assistant_rename_conversation: ['p_conversation_id', 'p_title'],
  // Actions, reminders, schedules, notifications, morning brief, ideas, weekly look-at
  staff_assistant_create_reminder: [
    'p_title',
    'p_remind_at',
    'p_note',
    'p_conversation_id',
    'p_draft_id',
  ],
  staff_assistant_cancel_reminder: ['p_reminder_id'],
  staff_assistant_dispatch_due_reminders: [],
  staff_assistant_send_colleague_notification: [
    'p_recipient_email',
    'p_title',
    'p_message',
    'p_link_path',
    'p_conversation_id',
    'p_draft_id',
  ],
  staff_assistant_compute_next_run: [
    'p_frequency',
    'p_send_time_kampala',
    'p_day_of_week',
    'p_from',
  ],
  staff_assistant_create_schedule: [
    'p_title',
    'p_report_tool',
    'p_report_rpc',
    'p_report_args',
    'p_frequency',
    'p_recipient_emails',
    'p_day_of_week',
    'p_send_time_kampala',
    'p_custom_message',
    'p_conversation_id',
    'p_draft_id',
  ],
  staff_assistant_confirm_schedule_mfa: ['p_schedule_id'],
  staff_assistant_cancel_schedule: ['p_schedule_id'],
  staff_assistant_set_morning_brief_prefs: ['p_enabled', 'p_brief_time', 'p_dismiss_today'],
  staff_assistant_check_owner_access: ['p_owner_id'],
  staff_assistant_run_scheduled_report_as_owner: [
    'p_owner_id',
    'p_report_rpc',
    'p_report_args',
  ],
  staff_assistant_can_manage_ideas: ['p_user_id'],
  staff_assistant_save_idea: [
    'p_title',
    'p_suggestion',
    'p_evidence_summary',
    'p_figures',
    'p_source_label',
    'p_period_label',
    'p_category',
    'p_screen_path',
    'p_conversation_id',
    'p_message_id',
    'p_draft_id',
  ],
  staff_assistant_list_ideas: ['p_status', 'p_limit'],
  staff_assistant_update_idea_status: ['p_idea_id', 'p_status', 'p_status_note'],
  staff_assistant_weekly_look_at_summary: ['p_as_of'],
  staff_assistant_weekly_unanswered_list: ['p_days'],
  staff_assistant_refresh_daily_insights: ['p_as_of'],
  zoe_glossary_can_manage: ['p_user_id'],
  zoe_glossary_upsert_entry: [
    'p_slug',
    'p_term',
    'p_category',
    'p_plain_definition',
    'p_measurement_gotcha',
    'p_official_source',
    'p_screen_path',
    'p_keywords',
    'p_is_active',
  ],
  // Analyst lane helpers
  zoe_ro_area_allowed: ['p_area'],
  zoe_ro_area_requires_aal2: ['p_area'],
  zoe_ro_require_area: ['p_area'],
  zoe_ro_validate_query: ['p_sql'],
  staff_assistant_log_query: [
    'p_question',
    'p_sql',
    'p_executed_sql',
    'p_role_areas',
    'p_row_count',
    'p_truncated',
    'p_duration_ms',
    'p_status',
    'p_error_message',
  ],
  // Read-only Zoe tool RPCs (`assistant_staff_*`)
  assistant_staff_my_profile: [],
  assistant_staff_my_payslips: [],
  assistant_staff_my_tasks: ['p_status'],
  assistant_staff_my_tickets: [],
  assistant_staff_my_requisitions: [],
  assistant_staff_my_advances: [],
  assistant_staff_my_pending_concerns: [],
  assistant_staff_my_canteen: ['p_service_date'],
  assistant_staff_my_wallet: [],
  assistant_staff_my_reminders_and_schedules: ['p_include_cancelled'],
  assistant_staff_my_calls: ['p_from', 'p_to'],
  assistant_staff_my_work_summary: ['p_from', 'p_to'],
  assistant_staff_team_work_summary: ['p_department', 'p_from', 'p_to'],
  assistant_staff_my_taught_updates: [],
  assistant_staff_tops_first_seven_summary: ['p_from', 'p_to', 'p_frequency'],
  assistant_staff_tops_arrears_ageing: ['p_as_at', 'p_bucket', 'p_limit', 'p_offset', 'p_dir'],
  assistant_staff_tops_landlord_not_paid: ['p_as_at', 'p_limit', 'p_offset'],
  assistant_staff_tops_tenant_classification: [],
  assistant_staff_tops_smartphone_usage: ['p_from', 'p_to'],
  assistant_staff_tops_weekly_performance: ['p_anchor'],
  assistant_staff_tops_no_payment_report: ['p_min_days'],
  assistant_staff_tops_rent_request_lifetime: [],
  assistant_staff_tops_rent_requests_by_stage: ['p_from', 'p_to'],
  assistant_staff_tops_time_on_desk: ['p_stage', 'p_limit'],
  assistant_staff_tops_find_tenant: ['p_search', 'p_limit'],
  assistant_staff_tops_awareness_calls: ['p_from', 'p_to'],
  assistant_staff_lops_home_range: ['p_from', 'p_to'],
  assistant_staff_lops_paid_lists: ['p_tab', 'p_search', 'p_limit', 'p_offset'],
  assistant_staff_lops_principal_comparison: ['p_from', 'p_to'],
  assistant_staff_lops_calling_summary: ['p_from', 'p_to', 'p_week_start'],
  assistant_staff_lops_calling_coverage: ['p_as_at'],
  assistant_staff_lops_verification_queue: ['p_limit'],
  assistant_staff_aops_network_overview: ['p_from', 'p_to', 'p_min_expected'],
  assistant_staff_aops_metrics_totals: ['p_from', 'p_to'],
  assistant_staff_aops_metrics_agents: [
    'p_from',
    'p_to',
    'p_search',
    'p_sort',
    'p_scope',
    'p_limit',
  ],
  assistant_staff_aops_listing_quality_and_risk: ['p_from', 'p_to', 'p_limit'],
  assistant_staff_aops_silent_collectors: ['p_min_days_silent', 'p_limit'],
  assistant_staff_aops_subagent_teams: ['p_from', 'p_to', 'p_limit'],
  assistant_staff_pops_pending_summary: ['p_month'],
  assistant_staff_pops_report_overview: ['p_from', 'p_to'],
  assistant_staff_pops_search_supporters: ['p_search', 'p_limit'],
  assistant_staff_pso_cohort_performance: ['p_from', 'p_to'],
  assistant_staff_pops_returns_due: ['p_from', 'p_to'],
  assistant_staff_pops_topups_and_withdrawals_waiting: ['p_limit'],
  assistant_staff_cfo_treasury_cash_position: ['p_as_at'],
  assistant_staff_cfo_money_flow_summary: [],
  assistant_staff_cfo_receivables_and_payables: ['p_granularity', 'p_periods', 'p_as_at'],
  assistant_staff_cfo_seven_day_expenses: [],
  assistant_staff_cfo_budget_revised_position: [],
  assistant_staff_fops_verification_and_requisitions: ['p_from', 'p_to'],
  assistant_staff_fops_disbursements: ['p_from', 'p_to'],
  assistant_staff_fops_merchant_cashouts: ['p_from', 'p_to'],
  assistant_staff_coo_overview: ['p_days', 'p_from', 'p_to'],
  assistant_staff_ceo_growth_and_approvals: ['p_days'],
  assistant_staff_hr_calling_detailed_report: ['p_from', 'p_to'],
  assistant_staff_hr_contracts_and_birthdays: ['p_days'],
  assistant_staff_hr_payroll_cost_by_department: ['p_period_code'],
  assistant_staff_insight_desk_wait_times: ['p_weeks'],
  assistant_staff_insight_collection_coverage_trends: ['p_weeks'],
  assistant_staff_insight_calling_reach_and_themes: ['p_from', 'p_to'],
  assistant_staff_insight_payout_delays: ['p_weeks'],
  assistant_staff_insight_zoe_feedback_themes: ['p_days'],
  assistant_staff_get_glossary: ['p_search', 'p_category'],
  assistant_staff_data_catalog: ['p_area'],
  assistant_staff_get_data_catalog: ['p_area'],
  assistant_staff_run_query: ['p_sql', 'p_question'],
  assistant_staff_search_knowledge_base: ['p_query', 'p_category', 'p_limit'],
  assistant_staff_personalised_starters: [],
  assistant_staff_morning_brief_what_changed: [],
  staff_assistant_update_note: ['p_note_id', 'p_note_text'],
  staff_assistant_set_memory_prefs: ['p_memory_enabled', 'p_dismiss_preference_key'],
  staff_assistant_get_memory_prefs: [],
  staff_assistant_upsert_knowledge_entry: [
    'p_slug',
    'p_title',
    'p_category',
    'p_summary',
    'p_body',
    'p_measurement_gotcha',
    'p_official_source',
    'p_screen_path',
    'p_keywords',
    'p_review_status',
  ],
  staff_assistant_promote_to_eval_set: [
    'p_source_kind',
    'p_source_id',
    'p_cleaned_question',
    'p_expected_topic',
    'p_expected_tool',
    'p_notes',
  ],
  staff_assistant_weekly_manager_learning_view: ['p_days'],
};

/**
 * Internal helper / trigger functions defined in Zoe migrations that are not
 * directly invoked via `.rpc()`, kept in the known-functions set for reverse
 * live drift checks.
 */
export const INTERNAL_ZOE_FUNCTIONS = [
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
  'assistant_staff_welile_glossary',
  'assistant_staff_my_tasks_and_attendance',
  'assistant_staff_my_work_logs',
  'assistant_staff_my_concerns',
];

function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/--[^\n]*/g, ' ');
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '.git' || name === 'dist' || name === '__tests__') {
        continue;
      }
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

/**
 * Checks that every Zoe migration file (and every new migration after 20261102130000)
 * in `supabase/migrations/` has a unique 14-digit numeric timestamp prefix across the
 * entire `supabase/migrations/` folder (no duplicate migration version numbers).
 */
export function auditDuplicateMigrationVersionPrefixes(migrationFilenames) {
  const errs = [];
  const byPrefix = new Map();
  for (const fname of migrationFilenames) {
    if (!fname.endsWith('.sql') || fname.endsWith('.rollback.sql')) continue;
    const m = fname.match(/^(\d{14})_(.+)\.sql$/);
    if (!m) continue;
    const prefix = m[1];
    const existing = byPrefix.get(prefix) ?? [];
    existing.push(fname);
    byPrefix.set(prefix, existing);
  }
  for (const [prefix, files] of byPrefix.entries()) {
    const touchesZoeOrNew =
      prefix > '20261102130000' || files.some((f) => f.includes('staff_assistant') || f.includes('zoe'));
    if (files.length > 1 && touchesZoeOrNew) {
      errs.push(
        `Duplicate migration version prefix "${prefix}" in supabase/migrations: ${files.join(', ')}`,
      );
    }
  }
  return errs;
}

/**
 * Reverse drift check: fails if any live `staff_assistant_*` or `assistant_staff_*`
 * table/function or `zoe_ro.*` view exists in the database without a matching
 * migration definition in the repository manifest.
 */
export function auditReverseLiveDrift(
  liveTables,
  liveViews,
  liveFunctions,
  manifestTables,
  manifestViews,
  manifestFunctions,
) {
  const errs = [];
  for (const tbl of liveTables) {
    if (!manifestTables.has(tbl.toLowerCase())) {
      errs.push(
        `zoe_live_untracked_drift: live table "public.${tbl}" has no matching definition in the Zoe migration manifest.`,
      );
    }
  }
  for (const vw of liveViews) {
    if (!manifestViews.has(vw.toLowerCase())) {
      errs.push(
        `zoe_live_untracked_drift: live view "${vw}" has no matching definition in the Zoe migration manifest.`,
      );
    }
  }
  for (const fn of liveFunctions) {
    if (!manifestFunctions.has(fn.toLowerCase())) {
      errs.push(
        `zoe_live_untracked_drift: live function "public.${fn}" has no matching definition in the Zoe migration manifest.`,
      );
    }
  }
  return errs;
}

/**
 * Audits code files against the parity manifest (`REQUIRED_ZOE_TABLES`, `REQUIRED_ZOE_RPCS`).
 */
export function auditCodeParity(fileLabel, rawCode, manifestTables, manifestRpcs) {
  const errs = [];
  const clean = stripComments(rawCode);

  // 1. Check .from("staff_assistant_*")
  const fromRe = /\.from\(\s*['"`](staff_assistant_[a-z0-9_]+)['"`]/gi;
  for (const m of clean.matchAll(fromRe)) {
    const tbl = m[1].toLowerCase();
    if (!manifestTables.has(tbl)) {
      errs.push(
        `${fileLabel}: references table "${tbl}" via .from(), which is missing from the Zoe parity manifest.`,
      );
    }
  }

  // 2. Check .rpc("staff_assistant_* | assistant_staff_* | zoe_*", { ... })
  const rpcRe =
    /\.rpc\(\s*['"`]((?:staff_assistant|assistant_staff|zoe)_[a-z0-9_]+)['"`](?:\s+as\s+never)?(?:\s*,\s*\{([^}]*)\})?/gi;
  for (const m of clean.matchAll(rpcRe)) {
    const rpcName = m[1].toLowerCase();
    const argBlock = m[2] ?? '';
    const allowedParams = manifestRpcs.get(rpcName);
    if (!allowedParams) {
      errs.push(
        `${fileLabel}: calls RPC "${rpcName}" via .rpc(), which is missing from the Zoe parity manifest.`,
      );
      continue;
    }

    const argKeyRe = /(?:^|[,{\s])(p_[a-z0-9_]+)\s*:/gi;
    for (const am of argBlock.matchAll(argKeyRe)) {
      const paramName = am[1].toLowerCase();
      if (!allowedParams.has(paramName)) {
        errs.push(
          `${fileLabel}: passes parameter "${paramName}" to RPC "${rpcName}", which only accepts [${[...allowedParams].join(', ')}].`,
        );
      }
    }
  }

  // 3. Check STAFF_TOOLS `rpc: "assistant_staff_*"` definitions
  const toolRpcRe = /\brpc\s*:\s*['"`](assistant_staff_[a-z0-9_]+)['"`]/gi;
  for (const m of clean.matchAll(toolRpcRe)) {
    const rpcName = m[1].toLowerCase();
    if (!manifestRpcs.has(rpcName)) {
      errs.push(
        `${fileLabel}: registers tool RPC "${rpcName}", which is missing from the Zoe parity manifest.`,
      );
    }
  }

  return errs;
}

/**
 * Scans cumulative Zoe SQL migrations to verify every table, column, view, and RPC
 * in the manifest is created in `supabase/migrations/`.
 */
export function auditMigrationsCoverManifest(
  combinedSqlText,
  requiredTables,
  requiredColumns,
  requiredViews,
  requiredRpcs,
) {
  const errs = [];
  const clean = stripComments(combinedSqlText);

  for (const tbl of requiredTables) {
    const createTblRe = new RegExp(
      `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:public\\.)?${tbl}\\b`,
      'i',
    );
    if (!createTblRe.test(clean)) {
      errs.push(`Missing CREATE TABLE for public.${tbl} in supabase/migrations.`);
    }
    const mfaPolicyRe = new RegExp(
      `CREATE\\s+POLICY\\s+"?mfa_required_for_staff"?\\s+ON\\s+(?:public\\.)?${tbl}\\b`,
      'i',
    );
    if (!mfaPolicyRe.test(clean)) {
      errs.push(`Missing mfa_required_for_staff policy on public.${tbl} in supabase/migrations.`);
    }
  }

  for (const [tbl, cols] of Object.entries(requiredColumns)) {
    for (const col of cols) {
      const colRe = new RegExp(`\\b${col}\\b`, 'i');
      if (!colRe.test(clean)) {
        errs.push(`Missing column definition "${tbl}.${col}" in supabase/migrations.`);
      }
    }
  }

  for (const view of requiredViews) {
    const escapedView = view.replace('.', '\\.');
    const createViewRe = new RegExp(
      `CREATE\\s+(?:OR\\s+REPLACE\\s+)?VIEW\\s+${escapedView}\\b`,
      'i',
    );
    if (!createViewRe.test(clean)) {
      errs.push(`Missing CREATE VIEW for ${view} in supabase/migrations.`);
    }
  }

  for (const [rpcName, params] of Object.entries(requiredRpcs)) {
    const createFnRe = new RegExp(
      `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${rpcName}\\s*\\(([^)]*)\\)`,
      'gi',
    );
    const matches = [...clean.matchAll(createFnRe)];
    if (matches.length === 0) {
      errs.push(`Missing CREATE FUNCTION for public.${rpcName}() in supabase/migrations.`);
      continue;
    }
    const lastArgs = matches[matches.length - 1][1].toLowerCase();
    for (const p of params) {
      if (!new RegExp(`\\b${p.toLowerCase()}\\b`).test(lastArgs)) {
        errs.push(
          `Function public.${rpcName}() in supabase/migrations is missing expected parameter "${p}".`,
        );
      }
    }
  }

  return errs;
}

// ============================================================================
// Self-Test
// ============================================================================
export function runSelfTests() {
  const tables = new Set(['staff_assistant_config']);
  const views = new Set(['zoe_ro.finance_treasury_cash_position']);
  const rpcs = new Map([['staff_assistant_has_access', new Set()]]);

  const badTableErrs = auditCodeParity(
    'synthetic/badTable.ts',
    `await db.from("staff_assistant_nonexistent").select("*");`,
    tables,
    rpcs,
  );
  if (badTableErrs.length === 0) {
    throw new Error('Self-test failed: did not catch unregistered staff_assistant_* table.');
  }

  const badRpcErrs = auditCodeParity(
    'synthetic/badRpc.ts',
    `await userClient.rpc("staff_assistant_unknown_rpc", { p_foo: 1 });`,
    tables,
    rpcs,
  );
  if (badRpcErrs.length === 0) {
    throw new Error('Self-test failed: did not catch unregistered staff_assistant_* RPC.');
  }

  const badParamErrs = auditCodeParity(
    'synthetic/badParam.ts',
    `await userClient.rpc("staff_assistant_has_access", { p_wrong_arg: true });`,
    tables,
    rpcs,
  );
  if (badParamErrs.length === 0) {
    throw new Error('Self-test failed: did not catch undeclared RPC parameter.');
  }

  const dupMigrationErrs = auditDuplicateMigrationVersionPrefixes([
    '20261030100000_tlb_tenants_multi.sql',
    '20261030100000_staff_assistant_parity.sql',
  ]);
  if (dupMigrationErrs.length === 0) {
    throw new Error('Self-test failed: did not catch duplicate migration version prefix.');
  }

  const reverseDriftErrs = auditReverseLiveDrift(
    ['staff_assistant_config', 'staff_assistant_untracked_live_table'],
    ['zoe_ro.finance_treasury_cash_position'],
    ['staff_assistant_has_access', 'staff_assistant_untracked_live_fn'],
    tables,
    views,
    new Set(['staff_assistant_has_access']),
  );
  if (reverseDriftErrs.length !== 2) {
    throw new Error('Self-test failed: did not catch untracked live table/function reverse drift.');
  }
}

runSelfTests();
if (process.argv.includes('--self-test')) {
  console.log('[guard:zoe-parity] self-tests passed');
  process.exit(0);
}

// ============================================================================
// Repository Parity Scan
// ============================================================================
const errors = [];
function fail(msg) {
  errors.push(msg);
}

const manifestTables = new Set(REQUIRED_ZOE_TABLES.map((t) => t.toLowerCase()));
const manifestViews = new Set(REQUIRED_ZOE_VIEWS.map((v) => v.toLowerCase()));
const manifestRpcs = new Map(
  Object.entries(REQUIRED_ZOE_RPCS).map(([k, v]) => [
    k.toLowerCase(),
    new Set(v.map((p) => p.toLowerCase())),
  ]),
);
const allKnownZoeFunctions = new Set([
  ...Object.keys(REQUIRED_ZOE_RPCS).map((k) => k.toLowerCase()),
  ...INTERNAL_ZOE_FUNCTIONS.map((k) => k.toLowerCase()),
]);

// 0. Check for duplicate migration version prefixes across supabase/migrations/
const allMigrationFilenames = readdirSync(MIGRATIONS_DIR).sort();
for (const err of auditDuplicateMigrationVersionPrefixes(allMigrationFilenames)) {
  fail(err);
}

// 1. Scan Zoe edge functions and frontend files
const scanDirs = [
  join(ROOT, 'supabase', 'functions', 'staff-assistant'),
  join(ROOT, 'supabase', 'functions', 'staff-assistant-send-email'),
  join(ROOT, 'supabase', 'functions', 'staff-assistant-schedule-runner'),
  join(ROOT, 'src', 'components', 'zoe'),
  join(ROOT, 'src', 'lib', 'zoe'),
];
const scanFiles = [];
for (const d of scanDirs) {
  for (const f of walk(d)) {
    if (/\.(ts|tsx)$/.test(f) && !f.endsWith('_test.ts') && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx')) {
      scanFiles.push(f);
    }
  }
}
const crmHookPath = join(ROOT, 'src', 'hooks', 'useZoeCrm.ts');
if (existsSync(crmHookPath)) scanFiles.push(crmHookPath);

for (const file of scanFiles) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const raw = readFileSync(file, 'utf8');
  for (const err of auditCodeParity(rel, raw, manifestTables, manifestRpcs)) {
    fail(err);
  }
}

// 2. Verify startup health check (`staff_assistant_health` + `zoe_database_behind`) in staff-assistant
const storeTsPath = join(ROOT, 'supabase', 'functions', 'staff-assistant', 'store.ts');
const indexTsPath = join(ROOT, 'supabase', 'functions', 'staff-assistant', 'index.ts');
const combinedEdgeCode = [storeTsPath, indexTsPath]
  .filter((p) => existsSync(p))
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');

if (!/staff_assistant_health/.test(combinedEdgeCode)) {
  fail('supabase/functions/staff-assistant must call staff_assistant_health (cached 60s) on startup.');
}
if (!/zoe_database_behind/.test(combinedEdgeCode)) {
  fail('supabase/functions/staff-assistant must report "zoe_database_behind" when database objects are missing.');
}

// 3. Verify Zoe SQL migrations define every manifest object, and no Zoe migration defines an unregistered object
const zoeMigrations = allMigrationFilenames
  .filter((f) => f.endsWith('.sql') && f.includes('staff_assistant'))
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
  .join('\n');

for (const err of auditMigrationsCoverManifest(
  zoeMigrations,
  REQUIRED_ZOE_TABLES,
  REQUIRED_ZOE_COLUMNS,
  REQUIRED_ZOE_VIEWS,
  REQUIRED_ZOE_RPCS,
)) {
  fail(err);
}

// 4. Verify required parity audit docs and SQL verification test exist
for (const requiredRel of [
  'docs/zoe/parity-audit.md',
  'docs/zoe/deploy-order.md',
  'docs/zoe/schema-drift-reconciliation.md',
  'supabase/tests/zoe_live_parity.sql',
]) {
  const abs = join(ROOT, requiredRel);
  if (!existsSync(abs)) {
    fail(`Missing required parity file: ${requiredRel}`);
  }
}

// 5. Optional live database check (`--check-live`, `--live`, or `ZOE_PARITY_CHECK_LIVE=1`)
if (
  process.argv.includes('--check-live') ||
  process.argv.includes('--live') ||
  process.env.ZOE_PARITY_CHECK_LIVE === '1'
) {
  const paritySqlPath = join(ROOT, 'supabase', 'tests', 'zoe_live_parity.sql');
  const res = spawnSync(
    'npx',
    ['supabase', 'db', 'query', '--linked', '-f', paritySqlPath],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim();
  if (res.status !== 0 || /zoe_database_behind|zoe_live_untracked_drift/i.test(out)) {
    fail(`zoe_database_behind: live database parity or reverse drift check failed.\n${out}`);
  } else {
    console.log('[guard:zoe-parity] live database parity & reverse-drift check ok');
  }
}

if (errors.length > 0) {
  console.error(`[guard:zoe-parity] ${errors.length} violation(s):\n`);
  for (const e of errors) console.error(`  - ${e}\n`);
  process.exit(1);
}

console.log(
  `[guard:zoe-parity] ok — ${REQUIRED_ZOE_TABLES.length} tables, ` +
    `${Object.values(REQUIRED_ZOE_COLUMNS).reduce((s, a) => s + a.length, 0)} columns, ` +
    `${REQUIRED_ZOE_VIEWS.length} views, and ${Object.keys(REQUIRED_ZOE_RPCS).length} RPCs verified across ${scanFiles.length} code files (${allKnownZoeFunctions.size} total Zoe functions tracked)`,
);
