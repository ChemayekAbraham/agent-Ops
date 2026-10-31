# Zoe Production Database Parity Audit

**Audited against live database:** Project `43e6c2e1-18a6-4503-badb-5bb6c23491cc` (read-only `npx supabase db query --linked`)  
**Audit date:** 2026-10-30 (Africa/Kampala)

---

## 1. Root Cause of Production Errors

When a staff member asks Zoe a question in production, the deployed `staff-assistant` edge function calls database objects introduced in migrations `20261026150000` through `20261029180000` (plus `staff_assistant_get_config` and `assistant_staff_get_data_catalog`), none of which exist in the live database:

1. **Missing Zoe migrations (`20261026150000` to `20261029180000`):** Only the first 4 Zoe migrations (`20261025230000`, `20261025233000`, `20261026000000`, `20261026130000`) were applied live. All 9 subsequent Zoe migrations (`20261026150000` through `20261029180000`) are unapplied live. Five of those files shared a 14-digit timestamp version prefix (`20261027150000`, `20261028110000`, `20261028150000`, `20261028180000`, `20261029180000`) with non-Zoe migrations that were recorded in `supabase_migrations.schema_migrations`.
2. **Unwrapped optional database calls in `store.ts` and `index.ts`:**
   - `loadStaffAssistantConfig` selects columns (`max_model_rounds`, `max_tool_calls`, `model_fast`, `model_deep`, `temperature`, `max_tokens`, `max_deep_model_rounds`, `max_deep_tool_calls`, `max_cost_usd_per_question`, `web_research_enabled`) that do not exist on live `public.staff_assistant_config`.
   - `getOrCreateConversation` and `recordTurn` reference columns (`created_at`, `last_message_at`, `updated_at`, `hidden_by_user`, `hidden_at`, `rolling_summary`) that do not exist on live `public.staff_assistant_conversations` and `public.staff_assistant_messages`.
   - `listUserNotes` queries `public.staff_assistant_notes`, which does not exist live.
   - `checkQuestionBudget` calls `public.staff_assistant_check_question_rate_limit`, which does not exist live.
   - Tool calls to `assistant_staff_get_glossary`, `assistant_staff_data_catalog` / `assistant_staff_get_data_catalog`, `assistant_staff_run_query`, and the 16 Prompt 3/4 report RPCs fail with `PGRST202` / `42883` (`function does not exist`) and immediately returned `MSG.error` (`"I'm having trouble reading that report right now. Please try again in a moment."`) instead of retrying without tools or answering general questions normally.

---

## 2. Live Status of Zoe Migrations (`20261025230000` – `20261030100000`)

| Migration File | Version Prefix | Exists Live? | `schema_migrations` Collision Note |
| :--- | :--- | :--- | :--- |
| `20261025230000_staff_assistant_foundation.sql` | `20261025230000` | **Yes** | Applied as `staff_assistant_foundation` |
| `20261025233000_staff_assistant_email_recipients.sql` | `20261025233000` | **Yes** | Applied as `staff_assistant_email_recipients` |
| `20261026000000_staff_assistant_read_tools_batch1.sql` | `20261026000000` | **Yes** | Applied as `staff_assistant_read_tools_batch1` |
| `20261026130000_staff_assistant_read_tools_batch2.sql` | `20261026130000` | **Yes** | Applied as `staff_assistant_read_tools_batch2` |
| `20261026150000_staff_assistant_crm_review_and_usage.sql` | `20261026150000` | **No** | Not in `schema_migrations` |
| `20261026160000_staff_assistant_actions_schedules_and_brief.sql` | `20261026160000` | **No** | Not in `schema_migrations` |
| `20261027100000_staff_assistant_security_hardening.sql` | `20261027100000` | **No** | Not in `schema_migrations` |
| `20261027130000_staff_assistant_prompt3_coverage_and_learning.sql` | `20261027130000` | **No** | Not in `schema_migrations` |
| `20261027150000_staff_assistant_prompt4_advisor_insights_and_ideas.sql` | `20261027150000` | **No** | Version `20261027150000` occupied by `user_wallet_strict_for_parity` |
| `20261028110000_staff_assistant_prompt1_live_fixes.sql` | `20261028110000` | **No** | Version `20261028110000` occupied by `landlord_calling_hub_foundation` |
| `20261028150000_staff_assistant_prompt2_brain_memory_glossary.sql` | `20261028150000` | **No** | Version `20261028150000` occupied by `landlord_calling_hub_exclude_tenants_and_journey_groups` |
| `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` | `20261028180000` | **No** | Version `20261028180000` occupied by `weekly_performance_agent_ops_alignment` |
| `20261029180000_staff_assistant_prompt4_consultant_and_proactive.sql` | `20261029180000` | **No** | Version `20261029180000` occupied by `weekly_performance_projection_by_schedule` |
| `20261030100000_staff_assistant_parity_health_and_error_codes.sql` | `20261030100000` | **No** | Prepared in Prompt 1 (health check, config RPC, catalog alias, error codes, error summary RPC) |

---

## 3. Complete Object Parity Matrix (Tables, Columns, Views, RPCs & Arguments)

### 3.1 Tables & Columns

| Object | Needed By | Exists Live (`yes`/`no`) | Migration File That Creates It |
| :--- | :--- | :--- | :--- |
| `public.staff_assistant_config` (table) | `staff-assistant/store.ts`, `staff-assistant-send-email/index.ts`, `staff-assistant-schedule-runner/index.ts` | **yes** | `20261025230000_staff_assistant_foundation.sql` |
| `public.staff_assistant_config.id` (`boolean`) | `staff-assistant/store.ts` | **yes** | `20261025230000_staff_assistant_foundation.sql` |
| `public.staff_assistant_config.enabled` (`boolean`) | `staff-assistant/store.ts`, `staff-assistant-send-email/index.ts`, `staff-assistant-schedule-runner/index.ts` | **yes** | `20261025230000_staff_assistant_foundation.sql` |
| `public.staff_assistant_config.max_questions_per_day` (`integer`) | `staff-assistant/store.ts` | **yes** | `20261025230000_staff_assistant_foundation.sql` |
| `public.staff_assistant_config.max_emails_per_day` (`integer`) | `staff-assistant/store.ts`, `staff-assistant-send-email/index.ts`, `staff-assistant-schedule-runner/index.ts` | **yes** | `20261025230000_staff_assistant_foundation.sql` |
| `public.staff_assistant_config.history_days` (`integer`) | `staff-assistant/store.ts` | **yes** | `20261025230000_staff_assistant_foundation.sql` |
| `public.staff_assistant_config.updated_at` (`timestamptz`) | `staff-assistant/store.ts` | **yes** | `20261025230000_staff_assistant_foundation.sql` |
| `public.staff_assistant_config.updated_by` (`uuid`) | `staff-assistant/store.ts` | **yes** | `20261025230000_staff_assistant_foundation.sql` |
| `public.staff_assistant_config.max_model_rounds` (`integer`) | `staff-assistant/store.ts`, `staff-assistant/index.ts` | **no** | `20261027100000_staff_assistant_security_hardening.sql` |
| `public.staff_assistant_config.max_tool_calls` (`integer`) | `staff-assistant/store.ts`, `staff-assistant/index.ts` | **no** | `20261027100000_staff_assistant_security_hardening.sql` |
| `public.staff_assistant_config.max_notifications_per_day` (`integer`) | `staff_assistant_send_colleague_notification` | **no** | `20261027100000_staff_assistant_security_hardening.sql` |
| `public.staff_assistant_config.model_fast` (`text`) | `staff-assistant/store.ts`, `staff-assistant/index.ts`, `staff-assistant/openai.ts` | **no** | `20261028150000_staff_assistant_prompt2_brain_memory_glossary.sql` |
| `public.staff_assistant_config.model_deep` (`text`) | `staff-assistant/store.ts`, `staff-assistant/index.ts`, `staff-assistant/openai.ts` | **no** | `20261028150000_staff_assistant_prompt2_brain_memory_glossary.sql` |
| `public.staff_assistant_config.temperature` (`numeric`) | `staff-assistant/store.ts`, `staff-assistant/index.ts` | **no** | `20261028150000_staff_assistant_prompt2_brain_memory_glossary.sql` |
| `public.staff_assistant_config.max_tokens` (`integer`) | `staff-assistant/store.ts`, `staff-assistant/index.ts` | **no** | `20261028150000_staff_assistant_prompt2_brain_memory_glossary.sql` |
| `public.staff_assistant_config.max_deep_model_rounds` (`integer`) | `staff-assistant/store.ts`, `staff-assistant/index.ts` | **no** | `20261028150000_staff_assistant_prompt2_brain_memory_glossary.sql` |
| `public.staff_assistant_config.max_deep_tool_calls` (`integer`) | `staff-assistant/store.ts`, `staff-assistant/index.ts` | **no** | `20261028150000_staff_assistant_prompt2_brain_memory_glossary.sql` |
| `public.staff_assistant_config.max_cost_usd_per_question` (`numeric`) | `staff-assistant/store.ts`, `staff-assistant/index.ts` | **no** | `20261028150000_staff_assistant_prompt2_brain_memory_glossary.sql` |
| `public.staff_assistant_config.web_research_enabled` (`boolean`) | `staff-assistant/store.ts`, `staff-assistant/index.ts` | **no** | `20261029180000_staff_assistant_prompt4_consultant_and_proactive.sql` |
| `public.staff_assistant_conversations` (table) | `staff-assistant/store.ts` | **yes** | `20261025230000_staff_assistant_foundation.sql` |
| `public.staff_assistant_conversations.{id,user_id,persona,title,status,started_at,last_active_at,closed_at,message_count,ip_address,user_agent,device_class,device_browser,device_os}` | `staff-assistant/store.ts` | **yes** | `20261025230000_staff_assistant_foundation.sql` |
| `public.staff_assistant_conversations.{hidden_by_user,hidden_at,created_at,last_message_at,updated_at}` | `staff-assistant/store.ts` | **no** | `20261027100000_staff_assistant_security_hardening.sql` (and `20261028110000`) |
| `public.staff_assistant_conversations.rolling_summary` (`text`) | `staff-assistant/store.ts`, `staff-assistant/index.ts` | **no** | `20261028150000_staff_assistant_prompt2_brain_memory_glossary.sql` |
| `public.staff_assistant_messages` (table) | `staff-assistant/store.ts` | **yes** | `20261025230000_staff_assistant_foundation.sql` |
| `public.staff_assistant_messages.{id,conversation_id,user_id,role,content,outcome,tools_called,source_label,period_label,report_payload,model,latency_ms,created_at}` | `staff-assistant/store.ts`, `staff-assistant/index.ts` | **yes** | `20261025230000_staff_assistant_foundation.sql` |
| `public.staff_assistant_messages.{hidden_by_user,hidden_at}` | `staff-assistant/store.ts` | **no** | `20261027100000_staff_assistant_security_hardening.sql` (and `20261028110000`) |
| `public.staff_assistant_feedback` (table) | `staff-assistant/store.ts` | **yes** | `20261025230000_staff_assistant_foundation.sql` |
| `public.staff_assistant_feedback.{id,conversation_id,message_id,user_id,rating,comment,created_at,updated_at}` | `staff-assistant/store.ts` | **yes** | `20261025230000_staff_assistant_foundation.sql` |
| `public.staff_assistant_feedback.report_kind` (`text`) | `staff-assistant/store.ts`, `staff-assistant/index.ts`, `src/components/zoe/useZoeAssistant.ts` | **no** | `20261029180000_staff_assistant_prompt4_consultant_and_proactive.sql` |
| `public.staff_assistant_unanswered` (table) | `staff-assistant/store.ts`, `src/hooks/useZoeCrm.ts` | **yes** | `20261025230000_staff_assistant_foundation.sql` |
| `public.staff_assistant_unanswered.{id,conversation_id,message_id,user_id,caller_roles,question_text,reason,status,reviewed_by,reviewed_at,review_note,created_at}` | `staff-assistant/store.ts`, `src/hooks/useZoeCrm.ts` | **yes** | `20261025230000_staff_assistant_foundation.sql` |
| `public.staff_assistant_unanswered.error_code` (`text`) | `staff-assistant/store.ts`, `staff-assistant/index.ts`, `src/hooks/useZoeCrm.ts` | **no** | `20261030100000_staff_assistant_parity_health_and_error_codes.sql` |
| `public.staff_assistant_unanswered.error_detail` (`text`) | `staff-assistant/store.ts`, `staff-assistant/index.ts` | **no** | `20261030100000_staff_assistant_parity_health_and_error_codes.sql` |
| `public.staff_assistant_reminders` (table) | `src/lib/zoe/zoeActions.ts`, `staff_assistant_create_reminder`, `staff_assistant_cancel_reminder` | **no** | `20261026160000_staff_assistant_actions_schedules_and_brief.sql` |
| `public.staff_assistant_schedules` (table) | `staff-assistant-schedule-runner/index.ts`, `src/lib/zoe/zoeActions.ts` | **no** | `20261026160000_staff_assistant_actions_schedules_and_brief.sql` |
| `public.staff_assistant_preferences` (table) | `src/lib/zoe/zoeActions.ts`, `staff-assistant/morningBrief.ts` | **no** | `20261026160000_staff_assistant_actions_schedules_and_brief.sql` |
| `public.staff_assistant_drafts` (table) | `staff-assistant/index.ts`, `staff-assistant-send-email/index.ts`, `src/lib/zoe/zoeActions.ts`, `src/lib/zoe/zoeEmailDraft.ts` | **no** | `20261027100000_staff_assistant_security_hardening.sql` |
| `public.staff_assistant_insights` (table) | `src/lib/zoe/zoeActions.ts`, `assistant_staff_insight_*` | **no** | `20261027150000_staff_assistant_prompt4_advisor_insights_and_ideas.sql` |
| `public.staff_assistant_ideas` (table) | `src/lib/zoe/zoeActions.ts`, `staff-assistant/index.ts` | **no** | `20261027150000_staff_assistant_prompt4_advisor_insights_and_ideas.sql` |
| `public.staff_assistant_notes` (table: `id, user_id, note_text, is_deleted, created_at, updated_at`) | `staff-assistant/store.ts`, `staff-assistant/index.ts`, `src/components/zoe/useZoeAssistant.ts` | **no** | `20261028150000_staff_assistant_prompt2_brain_memory_glossary.sql` |
| `public.staff_assistant_glossary` (table: `id, slug, term, category, plain_definition, measurement_gotcha, official_source, screen_path, keywords, is_active, updated_by, created_at, updated_at`) | `staff-assistant/index.ts`, `staff-assistant/tools.ts`, `src/components/zoe/useZoeAssistant.ts` | **no** | `20261028150000_staff_assistant_prompt2_brain_memory_glossary.sql` |
| `public.staff_assistant_data_catalog` (table: `view_name, role_area, requires_aal2, title, description, use_for, do_not_use_for, official_source, columns, created_at`) | `staff-assistant/tools.ts`, `staff-assistant/analyst.ts` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
| `public.staff_assistant_queries` (table: `id, user_id, question, sql_text, executed_sql, role_areas, row_count, truncated, duration_ms, status, error_message, created_at`) | `staff-assistant/store.ts`, `staff-assistant/index.ts`, `assistant_staff_run_query` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |

### 3.2 Read-Only Views (`zoe_ro.*` & Redacted CRM View)

| Object | Needed By | Exists Live (`yes`/`no`) | Migration File That Creates It |
| :--- | :--- | :--- | :--- |
| `public.v_staff_assistant_crm_messages_redacted` | `staff_assistant_crm_review_dashboard`, `staff_assistant_crm_conversation_thread` | **no** | `20261027100000_staff_assistant_security_hardening.sql` |
| `zoe_ro.finance_treasury_cash_position` | `assistant_staff_run_query`, `staff-assistant/analyst.ts` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
| `zoe_ro.finance_receivables_and_payables` | `assistant_staff_run_query`, `staff-assistant/analyst.ts` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
| `zoe_ro.finance_requisitions_summary` | `assistant_staff_run_query`, `staff-assistant/analyst.ts` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
| `zoe_ro.finance_budget_cycles` | `assistant_staff_run_query`, `staff-assistant/analyst.ts` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
| `zoe_ro.operations_daily_collection_coverage` | `assistant_staff_run_query`, `staff-assistant/analyst.ts` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
| `zoe_ro.operations_rent_plans_by_stage` | `assistant_staff_run_query`, `staff-assistant/analyst.ts` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
| `zoe_ro.calling_daily_attempts_summary` | `assistant_staff_run_query`, `staff-assistant/analyst.ts` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
| `zoe_ro.calling_pipeline_awareness_summary` | `assistant_staff_run_query`, `staff-assistant/analyst.ts` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
| `zoe_ro.hr_department_headcount` | `assistant_staff_run_query`, `staff-assistant/analyst.ts` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
| `zoe_ro.hr_contracts_overview` | `assistant_staff_run_query`, `staff-assistant/analyst.ts` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
| `zoe_ro.agents_daily_collections_by_region` | `assistant_staff_run_query`, `staff-assistant/analyst.ts` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
| `zoe_ro.agents_house_listings_summary` | `assistant_staff_run_query`, `staff-assistant/analyst.ts` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
| `zoe_ro.supporters_portfolios_summary` | `assistant_staff_run_query`, `staff-assistant/analyst.ts` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
| `zoe_ro.supporters_promissory_notes_summary` | `assistant_staff_run_query`, `staff-assistant/analyst.ts` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
| `zoe_ro.tenants_rent_plans_by_city` | `assistant_staff_run_query`, `staff-assistant/analyst.ts` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
| `zoe_ro.tenants_arrears_by_city` | `assistant_staff_run_query`, `staff-assistant/analyst.ts` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
| `zoe_ro.landlords_registry_by_district` | `assistant_staff_run_query`, `staff-assistant/analyst.ts` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
| `zoe_ro.landlords_payouts_summary` | `assistant_staff_run_query`, `staff-assistant/analyst.ts` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |

### 3.3 Functions / RPCs & Their Arguments

#### A. Access, Config, Security, Drafts, History, Actions, CRM & Health RPCs

| RPC & Arguments | Needed By | Exists Live (`yes`/`no`) | Migration File That Creates It |
| :--- | :--- | :--- | :--- |
| `staff_assistant_has_access()` | `staff-assistant/index.ts`, `staff-assistant-send-email/index.ts`, `staff-assistant-schedule-runner/index.ts`, `src/components/zoe/useZoeAssistant.ts` | **yes** | `20261025230000_staff_assistant_foundation.sql` |
| `staff_assistant_require_staff()` | Foundation & action RPCs | **yes** | `20261025230000_staff_assistant_foundation.sql` |
| `staff_assistant_purge_old_history()` | Daily retention `pg_cron` job | **yes** | `20261025230000_staff_assistant_foundation.sql` |
| `staff_assistant_email_recipients(p_search text)` | `staff-assistant/index.ts`, `staff-assistant-send-email/index.ts` | **yes** | `20261025233000_staff_assistant_email_recipients.sql` (hardened in `20261027100000`) |
| `staff_assistant_is_staff_email(p_email text)` | `staff-assistant-send-email/index.ts`, `staff-assistant-schedule-runner/index.ts` | **yes** | `20261025233000_staff_assistant_email_recipients.sql` (hardened in `20261027100000`) |
| `staff_assistant_can_view_pii(p_user_id uuid)` | `assistant_staff_*` report RPCs | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `staff_assistant_mask_phone(p_phone text, p_can_view_pii boolean)` | `assistant_staff_*` report RPCs | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `staff_assistant_mask_nin(p_nin text, p_can_view_pii boolean)` | `assistant_staff_*` report RPCs | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `staff_assistant_sanitize_jsonb(p_data jsonb, p_can_view_pii boolean, p_max_rows integer)` | `assistant_staff_*` report RPCs | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `staff_assistant_get_config()` | `staff-assistant/store.ts` (`loadStaffAssistantConfig`) | **no** | `20261030100000_staff_assistant_parity_health_and_error_codes.sql` |
| `staff_assistant_health()` | `staff-assistant/store.ts`, `staff-assistant/index.ts`, `scripts/guard-zoe-parity.mjs` | **no** | `20261030100000_staff_assistant_parity_health_and_error_codes.sql` |
| `staff_assistant_error_summary(p_days integer)` | `src/hooks/useZoeCrm.ts`, `src/components/executive/crm/ZoeConversationsPanel.tsx` | **no** | `20261030100000_staff_assistant_parity_health_and_error_codes.sql` |
| `staff_assistant_can_user_read_report(p_user_id uuid, p_report_rpc text)` | `staff-assistant/index.ts`, `staff-assistant-send-email/index.ts`, `staff-assistant-schedule-runner/index.ts` | **no** | `20261027100000_staff_assistant_security_hardening.sql` (extended in `20261028180000` & `20261030100000`) |
| `staff_assistant_save_draft(p_kind text, p_payload jsonb, p_conversation_id uuid)` | `staff-assistant/index.ts`, `src/lib/zoe/zoeActions.ts`, `src/lib/zoe/zoeEmailDraft.ts` | **no** | `20261027100000_staff_assistant_security_hardening.sql` |
| `staff_assistant_consume_draft(p_draft_id uuid, p_expected_kind text, p_expected_payload jsonb)` | `staff-assistant-send-email/index.ts`, `staff_assistant_create_reminder`, `staff_assistant_send_colleague_notification`, `staff_assistant_create_schedule`, `staff_assistant_save_idea` | **no** | `20261027100000_staff_assistant_security_hardening.sql` |
| `staff_assistant_check_question_rate_limit(p_user_id uuid)` | `staff-assistant/store.ts` | **no** | `20261027100000_staff_assistant_security_hardening.sql` |
| `staff_assistant_check_email_budget(p_user_id uuid, p_recipient_count integer)` | `staff-assistant-send-email/index.ts`, `staff-assistant-schedule-runner/index.ts` | **no** | `20261027100000_staff_assistant_security_hardening.sql` |
| `staff_assistant_hide_my_history(p_user_id uuid, p_conversation_id uuid)` | `staff-assistant/store.ts` (`clearUserHistory`) | **no** | `20261027100000_staff_assistant_security_hardening.sql` |
| `staff_assistant_crm_can_review()` | `src/hooks/useZoeCrm.ts` | **no** | `20261026150000_staff_assistant_crm_review_and_usage.sql` |
| `staff_assistant_crm_review_dashboard(p_role_filter text, p_only_thumbs_down boolean, p_only_unanswered boolean, p_search text, p_days integer, p_limit integer)` | `src/hooks/useZoeCrm.ts` | **no** | `20261026150000_staff_assistant_crm_review_and_usage.sql` (redacted in `20261027100000`) |
| `staff_assistant_crm_conversation_thread(p_conversation_id uuid)` | `src/hooks/useZoeCrm.ts` | **no** | `20261026150000_staff_assistant_crm_review_and_usage.sql` (redacted in `20261027100000`) |
| `staff_assistant_create_reminder(p_note text, p_Remind_at timestamptz, p_conversation_id uuid, p_draft_id uuid)` | `src/lib/zoe/zoeActions.ts` | **no** | `20261026160000_staff_assistant_actions_schedules_and_brief.sql` (hardened in `20261027100000`) |
| `staff_assistant_cancel_reminder(p_reminder_id uuid)` | `src/lib/zoe/zoeActions.ts` | **no** | `20261026160000_staff_assistant_actions_schedules_and_brief.sql` |
| `staff_assistant_dispatch_due_reminders(p_limit integer)` | `staff-assistant-schedule-runner/index.ts` | **no** | `20261026160000_staff_assistant_actions_schedules_and_brief.sql` |
| `staff_assistant_send_colleague_notification(p_recipient_user_id uuid, p_title text, p_message text, p_link_path text, p_conversation_id uuid, p_draft_id uuid)` | `src/lib/zoe/zoeActions.ts` | **no** | `20261026160000_staff_assistant_actions_schedules_and_brief.sql` (hardened in `20261027100000`) |
| `staff_assistant_compute_next_run(p_frequency text, p_day_of_week integer, p_day_of_month integer, p_send_time time, p_from timestamptz)` | `staff-assistant-schedule-runner/index.ts`, `staff_assistant_create_schedule` | **no** | `20261026160000_staff_assistant_actions_schedules_and_brief.sql` |
| `staff_assistant_create_schedule(p_report_tool text, p_report_rpc text, p_report_args jsonb, p_report_title text, p_frequency text, p_day_of_week integer, p_day_of_month integer, p_send_time time, p_delivery_channel text, p_recipient_user_id uuid, p_recipient_email text, p_recipient_name text, p_conversation_id uuid, p_draft_id uuid)` | `src/lib/zoe/zoeActions.ts` | **no** | `20261026160000_staff_assistant_actions_schedules_and_brief.sql` (hardened in `20261027100000`) |
| `staff_assistant_cancel_schedule(p_schedule_id uuid)` | `src/lib/zoe/zoeActions.ts` | **no** | `20261026160000_staff_assistant_actions_schedules_and_brief.sql` |
| `staff_assistant_set_morning_brief_prefs(p_enabled boolean, p_brief_time time, p_dismiss_today boolean)` | `src/lib/zoe/zoeActions.ts` | **no** | `20261026160000_staff_assistant_actions_schedules_and_brief.sql` |
| `staff_assistant_check_owner_access(p_owner_user_id uuid)` | `staff-assistant-schedule-runner/index.ts` | **no** | `20261026160000_staff_assistant_actions_schedules_and_brief.sql` |
| `staff_assistant_run_scheduled_report_as_owner(p_owner_user_id uuid, p_report_rpc text, p_report_args jsonb)` | `staff-assistant-schedule-runner/index.ts` | **no** | `20261026160000_staff_assistant_actions_schedules_and_brief.sql` (hardened in `20261027100000`) |
| `staff_assistant_save_idea(p_title text, p_problem text, p_suggestion text, p_role_tag text, p_conversation_id uuid, p_draft_id uuid)` | `src/lib/zoe/zoeActions.ts` | **no** | `20261027150000_staff_assistant_prompt4_advisor_insights_and_ideas.sql` |
| `staff_assistant_list_ideas(p_status text, p_role_tag text, p_limit integer)` | `src/lib/zoe/zoeActions.ts` | **no** | `20261027150000_staff_assistant_prompt4_advisor_insights_and_ideas.sql` |
| `staff_assistant_update_idea_status(p_idea_id uuid, p_status text, p_manager_note text)` | `src/lib/zoe/zoeActions.ts` | **no** | `20261027150000_staff_assistant_prompt4_advisor_insights_and_ideas.sql` |
| `staff_assistant_weekly_look_at_summary(p_as_of date)` | `src/lib/zoe/zoeActions.ts` | **no** | `20261027150000_staff_assistant_prompt4_advisor_insights_and_ideas.sql` (upgraded in `20261029180000`) |
| `staff_assistant_weekly_unanswered_list(p_days integer)` | `staff_assistant_weekly_look_at_summary` | **no** | `20261029180000_staff_assistant_prompt4_consultant_and_proactive.sql` |
| `staff_assistant_refresh_weekly_insights(p_as_of date)` | Weekly insights `pg_cron` job | **no** | `20261027150000_staff_assistant_prompt4_advisor_insights_and_ideas.sql` |
| `zoe_glossary_can_manage(p_user_id uuid)` | `zoe_glossary_upsert_entry` | **no** | `20261028150000_staff_assistant_prompt2_brain_memory_glossary.sql` |
| `zoe_glossary_upsert_entry(p_slug text, p_term text, p_category text, p_plain_definition text, p_measurement_gotcha text, p_official_source text, p_screen_path text, p_keywords text[], p_is_active boolean)` | `src/components/zoe/useZoeAssistant.ts` | **no** | `20261028150000_staff_assistant_prompt2_brain_memory_glossary.sql` |

#### B. Read-Only Zoe Tool RPCs (`assistant_staff_*`)

| Tool Name | RPC & Arguments | Needed By | Exists Live (`yes`/`no`) | Migration File That Creates It |
| :--- | :--- | :--- | :--- | :--- |
| `get_my_profile` | `assistant_staff_my_profile()` | `staff-assistant/tools.ts`, `staff-assistant/index.ts`, `staff-assistant-send-email/index.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_my_payslips` | `assistant_staff_my_payslips(p_limit integer)` | `staff-assistant/tools.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_my_tasks` | `assistant_staff_my_tasks(p_status text, p_limit integer)` | `staff-assistant/tools.ts`, `staff-assistant/morningBrief.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_my_tickets` | `assistant_staff_my_tickets(p_status text, p_limit integer)` | `staff-assistant/tools.ts`, `staff-assistant/morningBrief.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_my_requisitions` | `assistant_staff_my_requisitions(p_status text, p_limit integer)` | `staff-assistant/tools.ts`, `staff-assistant/morningBrief.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_my_advances` | `assistant_staff_my_advances(p_limit integer)` | `staff-assistant/tools.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_my_pending_concerns` | `assistant_staff_my_pending_concerns(p_limit integer)` | `staff-assistant/tools.ts`, `staff-assistant/morningBrief.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_my_canteen` | `assistant_staff_my_canteen(p_date date, p_limit integer)` | `staff-assistant/tools.ts`, `staff-assistant/morningBrief.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_my_wallet` | `assistant_staff_my_wallet(p_limit integer)` | `staff-assistant/tools.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_my_reminders_and_schedules` | `assistant_staff_my_reminders_and_schedules()` | `staff-assistant/tools.ts`, `staff-assistant/morningBrief.ts`, `src/components/zoe/useZoeAssistant.ts` | **no** | `20261026160000_staff_assistant_actions_schedules_and_brief.sql` |
| `get_my_calls` | `assistant_staff_my_calls(p_from date, p_to date)` | `staff-assistant/tools.ts` | **no** | `20261027130000_staff_assistant_prompt3_coverage_and_learning.sql` |
| `get_tops_first_seven_summary` | `assistant_staff_tops_first_seven_summary(p_from date, p_to date)` | `staff-assistant/tools.ts`, `staff-assistant/morningBrief.ts` | **yes** (needs `20261028110000` fix) | `20261026000000_staff_assistant_read_tools_batch1.sql` (`20261028110000` live fix) |
| `get_tops_arrears_ageing` | `assistant_staff_tops_arrears_ageing(p_as_of date, p_bucket text, p_limit integer)` | `staff-assistant/tools.ts` | **yes** (needs `20261028110000` fix) | `20261026000000_staff_assistant_read_tools_batch1.sql` (`20261028110000` live fix) |
| `get_tops_landlord_not_paid` | `assistant_staff_tops_landlord_not_paid(p_as_of date, p_limit integer)` | `staff-assistant/tools.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_tops_tenant_classification` | `assistant_staff_tops_tenant_classification(p_as_of date, p_classification text, p_limit integer)` | `staff-assistant/tools.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_tops_smartphone_usage` | `assistant_staff_tops_smartphone_usage(p_as_of date)` | `staff-assistant/tools.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_tops_weekly_performance` | `assistant_staff_tops_weekly_performance(p_week_start date)` | `staff-assistant/tools.ts`, `staff-assistant/morningBrief.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_tops_no_payment_report` | `assistant_staff_tops_no_payment_report(p_as_of date, p_min_days integer, p_limit integer)` | `staff-assistant/tools.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_tops_rent_request_lifetime` | `assistant_staff_tops_rent_request_lifetime(p_from date, p_to date)` | `staff-assistant/tools.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_tops_rent_requests_by_stage` | `assistant_staff_tops_rent_requests_by_stage(p_from date, p_to date, p_stage text, p_limit integer)` | `staff-assistant/tools.ts` | **no** | `20261027130000_staff_assistant_prompt3_coverage_and_learning.sql` |
| `get_tops_time_on_desk` | `assistant_staff_tops_time_on_desk(p_stage text, p_limit integer)` | `staff-assistant/tools.ts` | **no** | `20261027130000_staff_assistant_prompt3_coverage_and_learning.sql` |
| `get_tops_find_tenant` | `assistant_staff_tops_find_tenant(p_search text, p_limit integer)` | `staff-assistant/tools.ts` | **no** | `20261027130000_staff_assistant_prompt3_coverage_and_learning.sql` |
| `get_tops_awareness_calls` | `assistant_staff_tops_awareness_calls(p_from date, p_to date, p_stage text, p_limit integer)` | `staff-assistant/tools.ts` | **no** | `20261027130000_staff_assistant_prompt3_coverage_and_learning.sql` |
| `get_lops_home_range` | `assistant_staff_lops_home_range(p_from date, p_to date)` | `staff-assistant/tools.ts`, `staff-assistant/morningBrief.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_lops_paid_lists` | `assistant_staff_lops_paid_lists(p_list text, p_search text, p_limit integer)` | `staff-assistant/tools.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_lops_principal_comparison` | `assistant_staff_lops_principal_comparison(p_limit integer)` | `staff-assistant/tools.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_lops_calling_summary` | `assistant_staff_lops_calling_summary(p_from date, p_to date)` | `staff-assistant/tools.ts`, `staff-assistant/morningBrief.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_lops_calling_coverage` | `assistant_staff_lops_calling_coverage(p_from date, p_to date)` | `staff-assistant/tools.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_lops_verification_queue` | `assistant_staff_lops_verification_queue(p_kind text, p_limit integer)` | `staff-assistant/tools.ts` | **no** | `20261027130000_staff_assistant_prompt3_coverage_and_learning.sql` |
| `get_aops_network_overview` | `assistant_staff_aops_network_overview()` | `staff-assistant/tools.ts`, `staff-assistant/morningBrief.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_aops_metrics_totals` | `assistant_staff_aops_metrics_totals(p_from date, p_to date)` | `staff-assistant/tools.ts`, `staff-assistant/morningBrief.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_aops_metrics_agents` | `assistant_staff_aops_metrics_agents(p_from date, p_to date, p_search text, p_limit integer)` | `staff-assistant/tools.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_aops_listing_quality_and_risk` | `assistant_staff_aops_listing_quality_and_risk(p_limit integer)` | `staff-assistant/tools.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_aops_silent_collectors` | `assistant_staff_aops_silent_collectors(p_silent_days integer, p_limit integer)` | `staff-assistant/tools.ts` | **yes** | `20261026000000_staff_assistant_read_tools_batch1.sql` |
| `get_aops_subagent_teams` | `assistant_staff_aops_subagent_teams(p_search text, p_limit integer)` | `staff-assistant/tools.ts` | **no** | `20261027130000_staff_assistant_prompt3_coverage_and_learning.sql` |
| `get_pops_pending_summary` | `assistant_staff_pops_pending_summary()` | `staff-assistant/tools.ts`, `staff-assistant/morningBrief.ts` | **yes** | `20261026130000_staff_assistant_read_tools_batch2.sql` |
| `get_pops_report_overview` | `assistant_staff_pops_report_overview(p_from date, p_to date)` | `staff-assistant/tools.ts` | **yes** | `20261026130000_staff_assistant_read_tools_batch2.sql` |
| `get_pops_search_supporters` | `assistant_staff_pops_search_supporters(p_search text, p_limit integer)` | `staff-assistant/tools.ts` | **yes** | `20261026130000_staff_assistant_read_tools_batch2.sql` |
| `get_pso_cohort_performance` | `assistant_staff_pso_cohort_performance(p_cohort text)` | `staff-assistant/tools.ts`, `staff-assistant/morningBrief.ts` | **yes** | `20261026130000_staff_assistant_read_tools_batch2.sql` |
| `get_pops_returns_due` | `assistant_staff_pops_returns_due(p_from date, p_to date, p_limit integer)` | `staff-assistant/tools.ts` | **no** | `20261027130000_staff_assistant_prompt3_coverage_and_learning.sql` |
| `get_pops_topups_and_withdrawals_waiting` | `assistant_staff_pops_topups_and_withdrawals_waiting(p_kind text, p_limit integer)` | `staff-assistant/tools.ts` | **no** | `20261027130000_staff_assistant_prompt3_coverage_and_learning.sql` |
| `get_cfo_treasury_cash_position` | `assistant_staff_cfo_treasury_cash_position(p_as_of date)` | `staff-assistant/tools.ts`, `staff-assistant/morningBrief.ts` | **yes** | `20261026130000_staff_assistant_read_tools_batch2.sql` |
| `get_cfo_money_flow_summary` | `assistant_staff_cfo_money_flow_summary(p_from date, p_to date)` | `staff-assistant/tools.ts` | **yes** | `20261026130000_staff_assistant_read_tools_batch2.sql` |
| `get_cfo_receivables_and_payables` | `assistant_staff_cfo_receivables_and_payables(p_as_of date)` | `staff-assistant/tools.ts` | **yes** (needs `20261028110000` fix) | `20261026130000_staff_assistant_read_tools_batch2.sql` (`20261028110000` live fix) |
| `get_cfo_seven_day_expenses` | `assistant_staff_cfo_seven_day_expenses(p_from date, p_to date)` | `staff-assistant/tools.ts` | **yes** | `20261026130000_staff_assistant_read_tools_batch2.sql` |
| `get_cfo_budget_revised_position` | `assistant_staff_cfo_budget_revised_position(p_department text)` | `staff-assistant/tools.ts` | **yes** | `20261026130000_staff_assistant_read_tools_batch2.sql` |
| `get_fops_verification_and_requisitions` | `assistant_staff_fops_verification_and_requisitions(p_from date, p_to date)` | `staff-assistant/tools.ts`, `staff-assistant/morningBrief.ts` | **yes** | `20261026130000_staff_assistant_read_tools_batch2.sql` |
| `get_fops_disbursements` | `assistant_staff_fops_disbursements(p_from date, p_to date, p_limit integer)` | `staff-assistant/tools.ts` | **no** | `20261027130000_staff_assistant_prompt3_coverage_and_learning.sql` |
| `get_fops_merchant_cashouts` | `assistant_staff_fops_merchant_cashouts(p_status text, p_limit integer)` | `staff-assistant/tools.ts` | **no** | `20261027130000_staff_assistant_prompt3_coverage_and_learning.sql` |
| `get_coo_overview` | `assistant_staff_coo_overview(p_from date, p_to date)` | `staff-assistant/tools.ts`, `staff-assistant/morningBrief.ts` | **yes** | `20261026130000_staff_assistant_read_tools_batch2.sql` |
| `get_ceo_growth_and_approvals` | `assistant_staff_ceo_growth_and_approvals(p_from date, p_to date)` | `staff-assistant/tools.ts`, `staff-assistant/morningBrief.ts` | **yes** | `20261026130000_staff_assistant_read_tools_batch2.sql` |
| `get_hr_calling_detailed_report` | `assistant_staff_hr_calling_detailed_report(p_from date, p_to date, p_staff_search text)` | `staff-assistant/tools.ts` | **yes** (needs `20261028110000` fix) | `20261026130000_staff_assistant_read_tools_batch2.sql` (`20261028110000` live fix) |
| `get_hr_contracts_and_birthdays` | `assistant_staff_hr_contracts_and_birthdays(p_days_ahead integer)` | `staff-assistant/tools.ts`, `staff-assistant/morningBrief.ts` | **yes** | `20261026130000_staff_assistant_read_tools_batch2.sql` |
| `get_hr_payroll_cost_by_department` | `assistant_staff_hr_payroll_cost_by_department(p_year integer, p_month integer)` | `staff-assistant/tools.ts` | **yes** | `20261026130000_staff_assistant_read_tools_batch2.sql` |
| `get_insight_desk_wait_times` | `assistant_staff_insight_desk_wait_times(p_days integer)` | `staff-assistant/tools.ts` | **no** | `20261027150000_staff_assistant_prompt4_advisor_insights_and_ideas.sql` |
| `get_insight_collection_coverage_trends` | `assistant_staff_insight_collection_coverage_trends(p_days integer)` | `staff-assistant/tools.ts` | **no** | `20261027150000_staff_assistant_prompt4_advisor_insights_and_ideas.sql` |
| `get_insight_calling_reach_and_themes` | `assistant_staff_insight_calling_reach_and_themes(p_days integer)` | `staff-assistant/tools.ts` | **no** | `20261027150000_staff_assistant_prompt4_advisor_insights_and_ideas.sql` |
| `get_insight_payout_delays` | `assistant_staff_insight_payout_delays(p_days integer)` | `staff-assistant/tools.ts` | **no** | `20261027150000_staff_assistant_prompt4_advisor_insights_and_ideas.sql` |
| `get_insight_zoe_feedback_themes` | `assistant_staff_insight_zoe_feedback_themes(p_days integer)` | `staff-assistant/tools.ts` | **no** | `20261027150000_staff_assistant_prompt4_advisor_insights_and_ideas.sql` (updated in `20261029180000`) |
| `get_welile_glossary` | `assistant_staff_get_glossary(p_search text, p_category text)` | `staff-assistant/tools.ts`, `staff-assistant/index.ts`, `src/components/zoe/useZoeAssistant.ts` | **no** | `20261028150000_staff_assistant_prompt2_brain_memory_glossary.sql` |
| `get_data_catalog` | `assistant_staff_data_catalog(p_area text)` and `assistant_staff_get_data_catalog(p_area text)` | `staff-assistant/tools.ts`, `staff-assistant/index.ts` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` & `20261030100000_staff_assistant_parity_health_and_error_codes.sql` |
| `run_analyst_query` | `assistant_staff_run_query(p_sql text, p_question text)` | `staff-assistant/tools.ts`, `staff-assistant/index.ts` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |

#### C. Analyst Lane Helper Functions

| Function & Arguments | Needed By | Exists Live (`yes`/`no`) | Migration File That Creates It |
| :--- | :--- | :--- | :--- |
| `zoe_ro_area_allowed(p_area text)` | `zoe_ro.*` views, `assistant_staff_data_catalog` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
| `zoe_ro_area_is_sensitive(p_area text)` | `zoe_ro_require_area` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
| `zoe_ro_require_area(p_area text)` | `zoe_ro.*` views, `assistant_staff_run_query` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
| `zoe_ro_validate_query(p_sql text)` | `assistant_staff_run_query` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
| `staff_assistant_log_query(p_question text, p_sql text, p_executed_sql text, p_role_areas text[], p_row_count integer, p_truncated boolean, p_duration_ms integer, p_status text, p_error_message text)` | `assistant_staff_run_query` | **no** | `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` |
