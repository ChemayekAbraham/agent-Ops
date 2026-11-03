# Zoe Live Database Schema Drift Reconciliation

**Audited against live database:** Project `43e6c2e1-18a6-4503-badb-5bb6c23491cc`  
**Reconciliation date:** 2026-11-03 (Africa/Kampala)

---

## 1. Summary of Drift Found

In section 2 of `docs/ZOE_CONSOLIDATED_REVIEW_AND_ONE_PROMPT.md`, a live database check identified three objects existing in production with proper grants and RLS that had no committed migration file on `origin/lovable`:

1. `public.staff_assistant_projects` (table)
2. `public.staff_assistant_real_use_dashboard(p_days integer)` (function)
3. `public.assistant_staff_my_work_summary(p_from date, p_to date)` (function)

### Why It Happened

On 31 October 2026, migrations `20261031120000_staff_assistant_prompt1_reliability_and_real_use_dashboard.sql` and `20261031140000_staff_assistant_prompt2_files_coaching_projects_and_zoe_ro.sql` (followed by `20261031160000_staff_assistant_prompt3_teaching_loop_kb200_and_role_goals.sql`) were applied to the live database via `npx supabase db query --linked -f ...`, but those migration files remained untracked in the local workspace and had not yet been committed to `origin/lovable`. Additionally, versions `20261031140000` and `20261031160000` had not yet been inserted into `supabase_migrations.schema_migrations`.

---

## 2. Live Inspection Results (`pg_get_functiondef`, `information_schema.columns`, `pg_policy`, `role_table_grants`)

| Live Object | Kind | Live Definition & Security Posture | Reconciled Migration File |
| :--- | :--- | :--- | :--- |
| `public.staff_assistant_projects` | Table | Columns: `id uuid PK`, `user_id uuid FK auth.users`, `name text`, `instructions text`, `pinned_file_ids uuid[]`, `is_archived boolean`, `created_at timestamptz`, `updated_at timestamptz`. RLS enabled (`relrowsecurity = true`). Restrictive policy `mfa_required_for_staff` (`staff_assistant_has_access() AND aal = 'aal2'`). Owner policy `staff_assistant_projects_owner_all` (`user_id = (SELECT auth.uid())`). Grants: `SELECT, INSERT, UPDATE, DELETE` to `authenticated`; `0` grants to `anon`. | `supabase/migrations/20261031140000_staff_assistant_prompt2_files_coaching_projects_and_zoe_ro.sql` |
| `public.staff_assistant_uploads` | Table | Columns: `id`, `user_id`, `conversation_id`, `project_id`, `storage_path`, `file_name`, `mime_type`, `size_bytes` (`<= 10485760`), `extracted_summary`, `has_pii_warning`, `pii_warning_types`, `expires_at` (`90 days`), `created_at`. RLS enabled + restrictive `mfa_required_for_staff` + owner policy. Trigger `trg_staff_assistant_uploads_limit_per_chat` enforces max 5 files/chat and 10 MB/file. | `supabase/migrations/20261031140000_staff_assistant_prompt2_files_coaching_projects_and_zoe_ro.sql` |
| `public.staff_assistant_kb_zero_hits` | Table | Columns: `id`, `user_id`, `caller_roles`, `sanitized_query`, `routed_department`, `hit_count`, `last_seen_at`, `created_at`. RLS enabled + restrictive `mfa_required_for_staff` + reviewer/owner policy. | `supabase/migrations/20261031160000_staff_assistant_prompt3_teaching_loop_kb200_and_role_goals.sql` |
| `public.staff_assistant_real_use_dashboard(integer)` | Function | `STABLE SECURITY DEFINER SET search_path = public`. Checks `staff_assistant_crm_can_review()`. Returns `window_days`, `summary` (`active_users`, `questions`, `answered_count`, `answered_pct`, `refusals`, `errors`, `median_ttfb_ms`, `p95_ttfb_ms`, `total_cost_usd`, `thumbs_up`, `thumbs_down`, `analyst_use_count`, `research_use_count`), `by_day_and_role`, `errors_by_code`, `models_used` with zero question text. Granted `EXECUTE` to `authenticated` only (`anon_exec = false`). | `supabase/migrations/20261031120000_staff_assistant_prompt1_reliability_and_real_use_dashboard.sql` |
| `public.assistant_staff_my_work_summary(date, date)` | Function | `STABLE SECURITY DEFINER SET search_path = public`. Checks `staff_assistant_has_access()` and binds strictly to `(SELECT auth.uid())`. Compares caller's own calls, tasks, and reviews against caller's own prior period and anonymous team median (`advisory_notice: 'Suggestions only — never ratings or HR decisions.'`). Granted `EXECUTE` to `authenticated` only. | `supabase/migrations/20261031140000_staff_assistant_prompt2_files_coaching_projects_and_zoe_ro.sql` |
| `public.assistant_staff_team_work_summary(text, date, date)` | Function | `STABLE SECURITY DEFINER SET search_path = public`. Scoped strictly to manager/department lead's own department. Granted `EXECUTE` to `authenticated` only. | `supabase/migrations/20261031140000_staff_assistant_prompt2_files_coaching_projects_and_zoe_ro.sql` |
| `public.staff_assistant_department_teaching_queue(text, text, integer)` | Function | `STABLE SECURITY DEFINER SET search_path = public`. Checks `staff_assistant_crm_can_review()`. Returns redacted department review queue + zero-hit KB queries. Granted `EXECUTE` to `authenticated` only. | `supabase/migrations/20261031160000_staff_assistant_prompt3_teaching_loop_kb200_and_role_goals.sql` |
| `public.staff_assistant_teach_from_review_queue(...)` | Function | `SECURITY DEFINER SET search_path = public`. Checks `staff_assistant_crm_can_review()`. Records `created_by`, `approved_by`, `reviewed_by`, `reviewed_by_name`, `reviewed_at`, and 90-day `expires_at`. Granted `EXECUTE` to `authenticated` only. | `supabase/migrations/20261031160000_...sql` & `20261103180000_...sql` |
| `public.assistant_staff_my_taught_updates()` | Function | `SECURITY DEFINER SET search_path = public`. Returns taught KB answers for questions the signed-in caller asked (`"Zoe learned this from <Department>"`). Granted `EXECUTE` to `authenticated` only. | `supabase/migrations/20261031160000_staff_assistant_prompt3_teaching_loop_kb200_and_role_goals.sql` |
| `public.staff_assistant_role_goals_and_measures(integer)` | Function | `STABLE SECURITY DEFINER SET search_path = public`. Returns one operational goal and one live measure per role alongside Zoe usage with an explicit non-causal trend disclaimer. Granted `EXECUTE` to `authenticated` only. | `supabase/migrations/20261031160000_staff_assistant_prompt3_teaching_loop_kb200_and_role_goals.sql` |
| `zoe_ro.calling_my_space_officer_daily`, `zoe_ro.tenants_directory_by_stage_and_location`, `zoe_ro.operations_desk_turnaround_summary`, `zoe_ro.tenants_first_seven_days_cohort` | Views (4) | All 4 views have `WITH (security_invoker = true)`, call `public.zoe_ro_require_area(...)`, revoke from `PUBLIC, anon, service_role`, and grant `SELECT` to `authenticated`. | `supabase/migrations/20261031140000_staff_assistant_prompt2_files_coaching_projects_and_zoe_ro.sql` |

---

## 3. What Was Done to Reconcile & Lock Against Future Drift

1. **Committed the exact migration and rollback files:**
   - `supabase/migrations/20261031120000_staff_assistant_prompt1_reliability_and_real_use_dashboard.sql` (+ rollback)
   - `supabase/migrations/20261031140000_staff_assistant_prompt2_files_coaching_projects_and_zoe_ro.sql` (+ rollback)
   - `supabase/migrations/20261031160000_staff_assistant_prompt3_teaching_loop_kb200_and_role_goals.sql` (+ rollback)
   - `supabase/migrations/20261103180000_staff_assistant_consolidated_security_defences.sql` (+ rollback)
2. **Recorded all applied versions in `supabase_migrations.schema_migrations`:**
   - Verified `20261031120000`, `20261031140000`, `20261031160000`, and `20261103180000` are present in `supabase_migrations.schema_migrations` without re-running destructive DDL.
3. **Extended `scripts/guard-zoe-parity.mjs` and `supabase/tests/zoe_live_parity.sql`:**
   - Added `auditDuplicateMigrationVersionPrefixes` so the build fails if any two migration files in `supabase/migrations/` share a 14-digit version prefix.
   - Added `auditReverseLiveDrift` (and Section 9 in `supabase/tests/zoe_live_parity.sql`) so the parity check fails with `zoe_live_untracked_drift` if any `staff_assistant_*` or `assistant_staff_*` table/function or `zoe_ro.*` view exists in the live database without a matching committed migration file in `supabase/migrations/`.
