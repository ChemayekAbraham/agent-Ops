# Zoe Database Catch-Up Deployment Order & Verification Runbook

**Rule:** Database first. Apply the ordered migrations below and confirm `supabase/tests/zoe_live_parity.sql` passes **before** shipping any Zoe edge function or frontend code that depends on them.

---

## 1. Pre-Deploy Live Check (Read-Only)

Run the read-only parity audit query against the linked project to see what is currently missing:

```bash
npx supabase db query --linked -f supabase/tests/zoe_live_parity.sql
```

Or run the automated CLI parity check:

```bash
npm run guard:zoe-parity -- --check-live
```

---

## 2. Ordered Catch-Up Migrations (Idempotent)

Every migration below uses `IF NOT EXISTS`, `DROP ... IF EXISTS`, and `CREATE OR REPLACE`. Apply them in this exact chronological order:

| Step | Migration File | Rollback File | What It Creates / Updates |
| :---: | :--- | :--- | :--- |
| **1** | `supabase/migrations/20261026150000_staff_assistant_crm_review_and_usage.sql` | `supabase/rollbacks/20261026150000_staff_assistant_crm_review_and_usage_down.sql` | `staff_assistant_crm_can_review`, `staff_assistant_crm_review_dashboard`, `staff_assistant_crm_conversation_thread`, CRM review RLS policies |
| **2** | `supabase/migrations/20261026160000_staff_assistant_actions_schedules_and_brief.sql` | `supabase/rollbacks/20261026160000_staff_assistant_actions_schedules_and_brief_down.sql` | `staff_assistant_reminders`, `staff_assistant_schedules`, `staff_assistant_preferences`, reminder/schedule/notification/morning-brief RPCs, `assistant_staff_my_reminders_and_schedules` |
| **3** | `supabase/migrations/20261027100000_staff_assistant_security_hardening.sql` | `supabase/rollbacks/20261027100000_staff_assistant_security_hardening_down.sql` | `staff_assistant_drafts`, `staff_assistant_save_draft`, `staff_assistant_consume_draft`, `staff_assistant_can_user_read_report`, `staff_assistant_check_question_rate_limit`, `staff_assistant_check_email_budget`, `staff_assistant_hide_my_history`, `v_staff_assistant_crm_messages_redacted`, `max_model_rounds` / `max_tool_calls` / `max_notifications_per_day` on `staff_assistant_config`, `hidden_by_user` on conversations/messages |
| **4** | `supabase/migrations/20261027130000_staff_assistant_prompt3_coverage_and_learning.sql` | `supabase/rollbacks/20261027130000_staff_assistant_prompt3_coverage_and_learning.rollback.sql` | 11 department coverage RPCs (`assistant_staff_my_calls`, `assistant_staff_tops_rent_requests_by_stage`, `assistant_staff_tops_time_on_desk`, `assistant_staff_tops_find_tenant`, `assistant_staff_tops_awareness_calls`, `assistant_staff_lops_verification_queue`, `assistant_staff_aops_subagent_teams`, `assistant_staff_pops_returns_due`, `assistant_staff_pops_topups_and_withdrawals_waiting`, `assistant_staff_fops_disbursements`, `assistant_staff_fops_merchant_cashouts`) |
| **5** | `supabase/migrations/20261027150000_staff_assistant_prompt4_advisor_insights_and_ideas.sql` | `supabase/rollbacks/20261027150000_staff_assistant_prompt4_advisor_insights_and_ideas.rollback.sql` | `staff_assistant_insights`, `staff_assistant_ideas`, 5 `assistant_staff_insight_*` RPCs, `staff_assistant_save_idea`, `staff_assistant_list_ideas`, `staff_assistant_update_idea_status`, `staff_assistant_weekly_look_at_summary`, `staff_assistant_refresh_weekly_insights` |
| **6** | `supabase/migrations/20261028110000_staff_assistant_prompt1_live_fixes.sql` | `supabase/rollbacks/20261028110000_staff_assistant_prompt1_live_fixes.rollback.sql` | Fixes for `assistant_staff_hr_calling_detailed_report` (summary-first), `assistant_staff_tops_arrears_ageing` (`total_arrears_ugx`), `assistant_staff_cfo_receivables_and_payables` (fast sub-timeout), `assistant_staff_tops_first_seven_summary` (`uncollected`) |
| **7** | `supabase/migrations/20261028150000_staff_assistant_prompt2_brain_memory_glossary.sql` | `supabase/rollbacks/20261028150000_staff_assistant_prompt2_brain_memory_glossary.rollback.sql` | `model_fast`, `model_deep`, `temperature`, `max_tokens`, `max_deep_model_rounds`, `max_deep_tool_calls`, `max_cost_usd_per_question` on `staff_assistant_config`; `rolling_summary` on `staff_assistant_conversations`; `staff_assistant_notes`; `staff_assistant_glossary`; `assistant_staff_get_glossary`; `zoe_glossary_can_manage`; `zoe_glossary_upsert_entry` |
| **8** | `supabase/migrations/20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql` | `supabase/rollbacks/20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.rollback.sql` | `zoe_ro` schema & 18 read-only views (`security_invoker = true`), `staff_assistant_data_catalog`, `staff_assistant_queries` (append-only), `assistant_staff_data_catalog`, `assistant_staff_run_query`, `zoe_ro_validate_query`, `zoe_ro_require_area` |
| **9** | `supabase/migrations/20261029180500_staff_assistant_prompt4_consultant_and_proactive.sql` | `supabase/rollbacks/20261029180000_staff_assistant_prompt4_consultant_and_proactive.rollback.sql` | `web_research_enabled` on `staff_assistant_config`, `report_kind` on `staff_assistant_feedback`, `staff_assistant_weekly_unanswered_list`, upgraded `staff_assistant_weekly_look_at_summary` |
| **10** | `supabase/migrations/20261030100500_staff_assistant_parity_health_and_error_codes.sql` | `supabase/rollbacks/20261030100000_staff_assistant_parity_health_and_error_codes.rollback.sql` | `error_code` & `error_detail` on `staff_assistant_unanswered`, `staff_assistant_get_config()`, `assistant_staff_get_data_catalog(text)`, `staff_assistant_health()`, `staff_assistant_error_summary(integer)` |
| **11** | `supabase/migrations/20261030140500_staff_assistant_prompt4_learning_kb_and_starters.sql` | `supabase/rollbacks/20261030140000_staff_assistant_prompt4_learning_kb_and_starters.rollback.sql` | `staff_assistant_learning_log`, `staff_assistant_eval_candidates`, `staff_assistant_knowledge_base`, `assistant_staff_personalised_starters`, `assistant_staff_morning_brief_what_changed` |
| **12** | `supabase/migrations/20261031120000_staff_assistant_prompt1_reliability_and_real_use_dashboard.sql` | `supabase/rollbacks/20261031120000_staff_assistant_prompt1_reliability_and_real_use_dashboard.rollback.sql` | `requested_model`, `gateway_model`, `ttfb_ms`, `error_code`, `cost_usd`, `analyst_used`, `research_used` on `staff_assistant_messages` & `staff_assistant_learning_log`; `staff_assistant_real_use_dashboard(integer)` |
| **13** | `supabase/migrations/20261031140000_staff_assistant_prompt2_files_coaching_projects_and_zoe_ro.sql` | `supabase/rollbacks/20261031140000_staff_assistant_prompt2_files_coaching_projects_and_zoe_ro.rollback.sql` | `staff-assistant-uploads` private bucket, `staff_assistant_projects`, `staff_assistant_uploads`, `assistant_staff_my_work_summary`, `assistant_staff_team_work_summary`, 4 new `zoe_ro.*` views |
| **14** | `supabase/migrations/20261031160000_staff_assistant_prompt3_teaching_loop_kb200_and_role_goals.sql` | `supabase/rollbacks/20261031160000_staff_assistant_prompt3_teaching_loop_kb200_and_role_goals.rollback.sql` | `staff_assistant_kb_zero_hits`, `staff_assistant_department_teaching_queue`, `staff_assistant_teach_from_review_queue`, `assistant_staff_my_taught_updates`, `staff_assistant_role_goals_and_measures`, 216 KB entries |
| **15** | `supabase/migrations/20261103180000_staff_assistant_consolidated_security_defences.sql` | `supabase/rollbacks/20261103180000_staff_assistant_consolidated_security_defences.rollback.sql` | Reconciled `schema_migrations`, Analyst column allow-list in `zoe_ro_validate_query`, KB `created_by` & `approved_by`, push topic & voice disclosure preferences |

> **Important Note on Version Collisions in `supabase_migrations.schema_migrations`:**  
> Because versions `20261027150000`, `20261028110000`, `20261028150000`, `20261028180000`, and `20261029180000` are already recorded in `supabase_migrations.schema_migrations` under non-Zoe migration names, `supabase db push` would skip those 5 files if relied upon blindly. Execute each of the 10 SQL files above directly in order via the Supabase SQL Editor or `psql` / `supabase db query --linked -f <file>` when approved by the owner.

---

## 3. Post-Deploy Verification Checks

After the owner applies Steps 1–10:

1. **Run the SQL parity & security assertion suite:**
   ```bash
   npx supabase db query --linked -f supabase/tests/zoe_live_parity.sql
   ```
   Expected result: exits `0` with no exceptions.

2. **Run the Analyst Lane SQL firewall test suite:**
   ```bash
   npx supabase db query --linked -f supabase/tests/zoe_analyst_lane_security_test.sql
   ```
   Expected result: exits `0` with all write/DDL/sleep/cross-join/role/MFA assertions passing.

3. **Run the CLI parity guard against live:**
   ```bash
   npm run guard:zoe-parity -- --check-live
   ```
   Expected result: `[guard:zoe-parity] live database parity ok`.

---

## 4. Rollback Order (If Needed)

To roll back any step, run the matching rollback file in reverse order (Step 10 down to Step 1):

```bash
# Example: roll back Step 10 only
npx supabase db query --linked -f supabase/rollbacks/20261030100000_staff_assistant_parity_health_and_error_codes.rollback.sql
```
