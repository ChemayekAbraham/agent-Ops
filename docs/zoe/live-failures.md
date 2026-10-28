# Zoe (My Space Staff Assistant) — Live Failure Diagnosis & Migration Inventory

**Diagnosed against live database:** 28 October 2026 (`Africa/Kampala`)  
**Rule:** Prepared in code and migrations only — no migrations or edge functions deployed without explicit instruction.

---

## 1. Live Database State Snapshot

Direct read-only inspection of `public.staff_assistant_*` tables on the live database confirmed:

| Table | Live Row Count | Observed State |
| --- | ---: | --- |
| `public.staff_assistant_config` | `1` | `enabled = true`, `max_questions_per_day = 50`, `max_emails_per_day = 30`, `history_days = 90` |
| `public.staff_assistant_conversations` | `3` | `26d4e5e8-ae44-42a4-b64c-ee866af08f00` (`message_count = 34`), `62e2ced4-1c00-46d5-a38b-1960c13f3ae0` (`message_count = 4`), `ee047ae8-ec3c-4bc7-b0fb-179babd0fd03` (`message_count = 4`) |
| `public.staff_assistant_messages` | `0` | **0 rows** despite `message_count = 42` across the 3 conversations |
| `public.staff_assistant_unanswered` | `8` | **5 `error`**, **2 `missing_tool`**, **1 `unmatched`**; every row has `message_id = NULL` |
| `public.staff_assistant_feedback` | `0` | 0 rows |

---

## 2. Why `staff_assistant_messages` Had 0 Rows While 3 Conversations Existed

### Root Cause A — Heterogeneous Bulk Insert Violating `tools_called NOT NULL`
In `supabase/migrations/20261025230000_staff_assistant_foundation.sql` (line 140), `public.staff_assistant_messages` defines:
```sql
tools_called text[] NOT NULL DEFAULT '{}'
```
In `supabase/functions/staff-assistant/store.ts` (`recordTurn`), the edge function inserted both the user turn and the assistant turn in a single multi-row PostgREST `.insert([userRow, assistantRow])` call:
- `userRow` had only 4 keys: `{ conversation_id, user_id, role: "user", content }` (omitting `tools_called`).
- `assistantRow` had 11 keys: `{ conversation_id, user_id, role: "assistant", content, outcome, tools_called, source_label, period_label, report_payload, model, latency_ms }`.

When `supabase-js` sends a multi-row JSON array with heterogeneous keys to PostgREST, PostgREST normalizes the batch to the union of all keys across the array and populates omitted keys on `userRow` with SQL `NULL` (rather than the column `DEFAULT`). Consequently, `userRow.tools_called` was sent as `NULL`, causing PostgreSQL to reject the entire 2-row insert on every turn with:
```text
ERROR: 23502: null value in column "tools_called" of relation "staff_assistant_messages" violates not-null constraint
```
Because `recordTurn` did not inspect `error` on the `staff_assistant_messages` insert and immediately proceeded to `UPDATE public.staff_assistant_conversations SET message_count = message_count + 2`, every turn incremented `staff_assistant_conversations.message_count` (`34`, `4`, `4`) while inserting **0 rows** into `staff_assistant_messages` and returning `assistantMessageId = null` (which is why all 8 rows in `staff_assistant_unanswered` have `message_id = null`).

### Root Cause B — Undeployed Columns Referenced Without Fallback in `store.ts`
In later commits (`20261027100000` and `20261027130000`, which are not yet deployed live), `store.ts` began selecting/filtering/updating columns that do not yet exist on the live `staff_assistant_conversations` and `staff_assistant_messages` tables:
- `staff_assistant_conversations.conversation_summary` (from `20261027130000`)
- `staff_assistant_conversations.hidden_by_user` and `staff_assistant_messages.hidden_by_user` (from `20261027100000`)
- `staff_assistant_conversations.last_message_at` and `staff_assistant_conversations.created_at` (the foundation table uses `started_at` and `last_active_at`).

### Fix Applied
1. **`supabase/functions/staff-assistant/store.ts`**:
   - Explicitly sets `tools_called: []` (and `outcome: null`, `source_label: null`, `period_label: null`, `report_payload: null`, `model: null`, `latency_ms: null`) on `userRow` in `recordTurn` so both rows in `.insert([userRow, assistantRow])` have identical keys and `tools_called` is never `NULL`.
   - Adds a per-row fallback insert if a batch insert ever returns an error.
   - Adds automatic fallback queries in `getOrCreateConversation`, `loadRecentTurns`, `loadLatestReportPayload`, `recordTurn`, `loadConversationHistory`, `listUserConversations`, and `createNewConversation` when optional columns (`hidden_by_user`, `conversation_summary`, `last_message_at`, `created_at`) are not yet present on the live table, mapping `started_at` to `created_at`.
2. **`supabase/migrations/20261027100000_staff_assistant_security_hardening.sql` & `supabase/migrations/20261028110000_staff_assistant_prompt1_live_fixes.sql`**:
   - Adds `ADD COLUMN IF NOT EXISTS` for `created_at`, `last_message_at`, `updated_at`, `hidden_by_user`, `hidden_at`, and `conversation_summary` on `public.staff_assistant_conversations` (backfilled from `started_at` and `last_active_at`).

---

## 3. Diagnosis & Fix for All 8 Rows in `staff_assistant_unanswered`

| # | Row ID | Timestamp (UTC) | Caller Role | Question | Recorded Reason | Root Cause | Fix Applied |
| :-: | --- | --- | --- | --- | --- | --- | --- |
| 1 | `08d5ea5c-9f66-4c6e-bc6c-e3eb5312710f` | `2026-10-26 04:11:17Z` | `super_admin` | `"deliver the calling report for october"` | `error` | 1. `assistant_staff_hr_calling_detailed_report('2026-10-01', '2026-10-26')` returned **142,141 chars** (`1,272 ms`) because `detailed_rows` (200 full call objects with `extra` JSON) preceded `weekly_all_calls_summary` in Postgres `jsonb` key order. Slicing at `MAX_TOOL_RESULT_CHARS` (`16,000`) cut the JSON mid-way and dropped `weekly_all_calls_summary` and officer totals.<br>2. `max_tokens: 450` in `openai.ts` truncated the multi-officer October report mid-number, causing `checkAnswer` to fail on a cut-off figure (`unansweredReason: "error"`). | 1. `assistant_staff_hr_calling_detailed_report` in `20261028110000_staff_assistant_prompt1_live_fixes.sql` now computes a top-level `summary` (`total_calls`, `answered_calls`, `unanswered_calls`, `by_staff`, `by_source`) across the full date window and caps `detailed_rows` at 50 compact rows (~14 KB).<br>2. Default `maxTokens` in `openai.ts` raised from `450` to `1800`. |
| 2 | `9973503c-e22b-40f8-85f3-47b6eae1226f` | `2026-10-26 04:12:06Z` | `super_admin` | `"like call centers and calls for jane, hanisha and winnie"` | `missing_tool` | Asked 49 seconds after Row #1 in the same conversation (`ee047ae8-ec3c-4bc7-b0fb-179babd0fd03`). Because `recordTurn` failed to insert into `staff_assistant_messages` (Root Cause A), `loadRecentTurns` returned `[]`, stripping the prior turn context (`"deliver the calling report for october"`). Without prior context, the model answered conversationally without calling `get_hr_calling_detailed_report`, triggering `toolsCalled.length === 0` -> `missing_tool`. | 1. Fixed `recordTurn` in `store.ts` so conversation turns persist and `loadRecentTurns` supplies full 20-turn memory.<br>2. Updated `prompt.ts` and `tools.ts` so follow-up fragments mentioning Jane, Winnie, Hanisha, or Mark Bwayo route directly to `get_hr_calling_detailed_report`. |
| 3 | `634ef1a7-9f3b-4477-b66d-efb53a20dda7` | `2026-10-26 05:32:24Z` | `coo` | `"Show the Tenant Ops arrears ageing summary as of today."` | `error` | `assistant_staff_tops_arrears_ageing` returned `data.summary` with the 4 buckets (`1-7`: `15,292,479`, `8-14`: `38,489,445`, `15-30`: `63,698,875`, `30+`: `74,740,163`) and `total_row_count: 630`, but **no `total_arrears_ugx`** (`192,220,962`). When the model stated the total arrears across all 4 buckets (`UGX 192,220,962`) or referenced the `30+` bucket, `checkAnswer` in `guards.ts` rejected `192,220,962` as an unverified figure (`reason: "figure"` -> `unansweredReason: "error"`). | 1. `assistant_staff_tops_arrears_ageing` in `20261028110000_staff_assistant_prompt1_live_fixes.sql` now includes `total_arrears_ugx` and `total_plans` in `data.summary` and top-level output.<br>2. `guards.ts` (`buildAllowedNumbersPool` and `scrubStructuralTokens`) now grounds sums of `arrears_ugx`/`count` across bucket maps and scrubs `30+`. |
| 4 | `72d3f3d5-68ff-468f-aad0-12aed321cce4` | `2026-10-26 05:32:31Z` | `coo` | `"Show the Tenant Ops arrears ageing summary as of today."` | `error` | Retry of Row #3 seven seconds later; hit the exact same missing `total_arrears_ugx` bucket sum rejection in `checkAnswer` (`guards.ts`). | Fixed by the `assistant_staff_tops_arrears_ageing` and `guards.ts` bucket-sum grounding fixes above. |
| 5 | `ab39b172-faef-46a9-8043-ba60a77bf7a5` | `2026-10-26 05:32:53Z` | `coo` | `"Show company Receivables, Payables, and the weekly Payables forecast."` | `error` | Live timing measurement confirmed `assistant_staff_cfo_receivables_and_payables` takes **29,971 ms cold** and **7,947 ms warm** (`get_receivables_total`: `833 ms`, `get_payables_total`: `3,452 ms`, `get_payables_predictive_forecast`: `3,662 ms`). Calling it via PostgREST with an `authenticated` JWT exceeded PostgREST's 8-second `statement_timeout` (`57014`), returning a database error (`unansweredReason: "error"`). | 1. `assistant_staff_cfo_receivables_and_payables` in `20261028110000_staff_assistant_prompt1_live_fixes.sql` sets `SET statement_timeout = '25s'` on the `SECURITY DEFINER` function and wraps `get_payables_predictive_forecast` in an exception block so Receivables and Payables totals always return even if forecast times out.<br>2. `guards.ts` scrubs `Wk 41`..`Wk 48` week labels. |
| 6 | `53b43bd5-b74e-4096-a3d4-3a2a5045efe5` | `2026-10-26 06:18:51Z` | `tenant_ops` | `"How are newly funded Rent Plans performing in the First 7 Days report?"` | `error` | `assistant_staff_tops_first_seven_summary` returned `expected: 66541680` and `collected: 24580580`, plus `per_day` (Days 1–7), without `uncollected` (`41,961,100`). When the model stated the uncollected shortfall (`UGX 41,961,100`) or got cut off at `max_tokens: 450` while formatting the 7-day table, `checkAnswer` rejected the answer (`reason: "figure"` -> `unansweredReason: "error"`). | 1. `assistant_staff_tops_first_seven_summary` in `20261028110000_staff_assistant_prompt1_live_fixes.sql` adds `uncollected` (`expected - collected`) to `data`.<br>2. `guards.ts` grounds `expected - collected` and scrubs `Day 1`..`Day 7` labels.<br>3. `maxTokens` in `openai.ts` raised to `1800`. |
| 7 | `4e21c420-ba47-4d15-8c88-2725c42fd5ec` | `2026-10-27 09:50:17Z` | `coo` | `"yoo wassup"` | `missing_tool` | Casual slang greeting. On `2026-10-27 09:50:17Z`, conversational no-tool replies were not yet deployed live, and `CONVERSATIONAL_INTENT_RE` in `manualHelp.ts` only matched `hi|hello|hey|good morning|afternoon|evening|greetings` — not `yoo+`, `wassup`, `what's up`, `sup`, or `howdy`. | Expanded `CONVERSATIONAL_INTENT_RE` in `supabase/functions/staff-assistant/manualHelp.ts` to match casual greetings (`yo+`, `wass+up`, `what'?s up`, `sup`, `howdy`, `morning`, `afternoon`, `evening`, `how are you`, `how's it going`). |
| 8 | `d7fd546f-d8b9-4409-aea0-7f4c4e31f635` | `2026-10-27 09:51:00Z` | `coo` | `"Show the COO Command Center summary and Rent Coverage Statement."` | `unmatched` | 1. `get_coo_overview` in `tools.ts` had `.refine((v) => !(v.period && (v.from \|\| v.to)))` and `days: z.number().int().min(3).max(60)`, rejecting tool calls when the model passed both `period` and `from`/`to` (or `days: 1`) with `unansweredReason: "unmatched"`.<br>2. `max_tokens: 450` in `openai.ts` caused `google/gemini-3-flash-preview` to exhaust its token budget while summarizing both `overview_snapshot` and `rent_coverage_statement` (`!finalText` -> `unmatched`). | 1. Relaxed `PeriodArgsSchema` and `get_coo_overview` schema in `tools.ts` so `rangeArgs` deterministically resolves dates when both `period` and `from`/`to` are passed.<br>2. Raised default `maxTokens` in `openai.ts` from `450` to `1800`. |

---

## 4. Deployment Status of `20261026*` and `20261027*` Zoe Migrations

Verified against `information_schema.tables`, `information_schema.columns`, and `pg_proc` on the live database:

### Deployed on Live Database
1. **`20261025230000_staff_assistant_foundation.sql`** — **DEPLOYED** (`staff_assistant_config`, `staff_assistant_conversations`, `staff_assistant_messages`, `staff_assistant_feedback`, `staff_assistant_unanswered`, `staff_assistant_has_access`, `staff_assistant_require_staff`, `staff_assistant_purge_old_history`).
2. **`20261025233000_staff_assistant_email_recipients.sql`** — **DEPLOYED** (`staff_assistant_email_recipients`, `staff_assistant_is_staff_email`).
3. **`20261026000000_staff_assistant_read_tools_batch1.sql`** — **DEPLOYED** (22 `assistant_staff_*` RPCs for My Space, Tenant Ops, Landlord Ops + PII masking helpers).
4. **`20261026130000_staff_assistant_read_tools_batch2.sql`** — **DEPLOYED** (21 `assistant_staff_*` RPCs for Agent Ops, Partner Ops, CFO/FinOps, COO/CEO, HR & Calling).

### NOT Deployed on Live Database (Prepared Only — Do Not Push Without Instruction)

| Migration File | Live Status | Objects Created / Updated | What It Needs Before Applying |
| --- | --- | --- | --- |
| `20261026150000_staff_assistant_crm_review_and_usage.sql` | **NOT DEPLOYED** | `staff_assistant_is_crm_reviewer()`, `staff_assistant_unanswered_stamp_review()`, `staff_assistant_crm_review_dashboard()`, `staff_assistant_crm_conversation_thread()`, CRM RLS policies on the 4 foundation tables. | Depends only on `20261025230000` and `20261025233000` (both deployed). Ready to apply cleanly first in sequence; note that `20261027100000` later replaces `staff_assistant_crm_review_dashboard` and `staff_assistant_crm_conversation_thread` with PII-redacted versions. |
| `20261026160000_staff_assistant_actions_schedules_and_brief.sql` | **NOT DEPLOYED** | Updates `block_all_notification_inserts()`; creates tables `staff_assistant_reminders`, `staff_assistant_schedules`, `staff_assistant_preferences` (with RLS + `mfa_required_for_staff`); creates `assistant_staff_my_reminders_and_schedules` and click-confirmed action RPCs (`staff_assistant_create_reminder`, `staff_assistant_cancel_reminder`, `staff_assistant_send_colleague_notification`, `staff_assistant_create_schedule`, `staff_assistant_cancel_schedule`, `staff_assistant_set_morning_brief_prefs`). | Depends on `20261025230000` and `20261025233000`. Ready to apply cleanly second in sequence. |
| `20261027100000_staff_assistant_security_hardening.sql` | **NOT DEPLOYED** | Soft-hide columns (`hidden_by_user`, `hidden_at`), 90-day delete guard trigger, `staff_assistant_hide_my_history()`, `staff_assistant_check_question_rate_limit()`, `staff_assistant_check_email_budget()`, table `staff_assistant_drafts` + `staff_assistant_save_draft()` / `staff_assistant_consume_draft()`, `staff_assistant_can_user_read_report()`, `v_staff_assistant_crm_messages_redacted`, and hardened action/CRM RPCs. | **Had a column bug (now fixed in repo):** line 66 created an index on `staff_assistant_conversations(user_id, last_message_at DESC)` and lines 2004/2090/2353 referenced `c.created_at`, `c.last_message_at`, and `c.updated_at`, which did not exist on `staff_assistant_conversations` (foundation used `started_at` and `last_active_at`). Fixed in `20261027100000` by adding `ADD COLUMN IF NOT EXISTS created_at`, `last_message_at`, and `updated_at` and backfilling from `started_at`/`last_active_at`. Requires `20261026150000` and `20261026160000` first. |
| `20261027130000_staff_assistant_prompt3_coverage_and_learning.sql` | **NOT DEPLOYED** | Adds `conversation_summary` on `staff_assistant_conversations`, `staff_assistant_rename_conversation()`, 11 read-only coverage RPCs (`assistant_staff_my_calls`, `assistant_staff_tops_rent_requests_by_stage`, `assistant_staff_tops_time_on_desk`, `assistant_staff_tops_find_tenant`, `assistant_staff_tops_awareness_calls`, `assistant_staff_lops_verification_queue`, `assistant_staff_aops_subagent_teams`, `assistant_staff_pops_returns_due`, `assistant_staff_pops_topups_and_withdrawals_waiting`, `assistant_staff_fops_disbursements`, `assistant_staff_fops_merchant_cashouts`), extends `staff_assistant_can_user_read_report()`, and adds `staff_assistant_crm_weekly_learning_report()`. | Requires `20261027100000` (with the `created_at` / `last_message_at` / `updated_at` columns added on `staff_assistant_conversations`). Ready to apply fourth in sequence. |
| `20261027150000_staff_assistant_prompt4_advisor_insights_and_ideas.sql` | **NOT DEPLOYED** | Extends `staff_assistant_drafts` for `'idea'`, creates `staff_assistant_insights` and `staff_assistant_ideas` (with grants, RLS, and `mfa_required_for_staff`), 5 `assistant_staff_insight_*` RPCs, `staff_assistant_refresh_daily_insights()`, `staff_assistant_save_idea()`, `staff_assistant_list_ideas()`, `staff_assistant_update_idea_status()`, and `staff_assistant_weekly_look_at_summary()`. | Requires `20261027100000` and `20261027130000` first. Ready to apply fifth in sequence. |
| `20261028110000_staff_assistant_prompt1_live_fixes.sql` | **PREPARED (NEW)** | Reconciles `staff_assistant_conversations` and `staff_assistant_messages` columns (`ADD COLUMN IF NOT EXISTS`), updates `assistant_staff_tops_first_seven_summary` (`uncollected`), `assistant_staff_tops_arrears_ageing` (`total_arrears_ugx`, `total_plans`), `assistant_staff_cfo_receivables_and_payables` (`SET statement_timeout = '25s'` + forecast timeout fallback), and `assistant_staff_hr_calling_detailed_report` (pre-aggregated `summary` + 50 compact `detailed_rows`). | Self-contained (`ADD COLUMN IF NOT EXISTS` + `CREATE OR REPLACE FUNCTION`); can be applied either immediately against current live DB or sixth after `20261027150000`. |
