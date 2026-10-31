# Zoe Prompt 1 Results — Database Parity, Catch-Up Plan & Resilient Request Handling

*Date*: 2026-10-30 (Africa/Kampala)  
*Branch*: `landlord-calling-hub-foundation` (synced with `origin/lovable`)

---

## Executive Summary

Zoe was failing in production (`"I'm having trouble reading that report right now"`) because code from Prompts 1–4 (`20261028110000` through `20261029180000`) was deployed to the `staff-assistant` edge function before the corresponding database migrations were applied live. In addition, the request handler (`handleStaffAssistantRequest`) treated missing optional RPCs and tool failures as fatal errors instead of logging a structured `error_code` and continuing in plain text.

Prompt 1 delivers seven permanent fixes so Zoe works even when optional database objects are behind, and never again ships code ahead of its database:

1. **Live Database Parity Audit (`docs/zoe/parity-audit.md`)**: Audited all 41 Zoe edge-function and frontend files against the live Supabase database (`npx supabase db query --linked`, read-only) across **15 tables, 117 columns, 19 `zoe_ro.*` views, and 111 RPCs**.
2. **Catch-Up Migration Plan & Rollbacks (`docs/zoe/deploy-order.md`, `supabase/tests/zoe_live_parity.sql`, `supabase/rollbacks/*`)**: Prepared the ordered, idempotent migration sequence (`20261028110000` → `20261028150000` → `20261028180000` → `20261029180000` → `20261030100000`), paired each with a rollback script, and created `supabase/tests/zoe_live_parity.sql` to verify every required object, `authenticated` grant, and `mfa_required_for_staff` policy. **No migrations were applied to the live database.**
3. **Static & Runtime Parity Guard (`scripts/guard-zoe-parity.mjs` + `staff_assistant_health`)**: Added `npm run guard:zoe-parity` (wired into `npm run guard:all`) and the read-only `staff_assistant_health()` RPC (cached for 60 seconds on edge-function startup), reporting `"zoe_database_behind"` with exact missing object names whenever the database lags the codebase.
4. **Resilient Request Handling (`supabase/functions/staff-assistant/index.ts` & `store.ts`)**: Wrapped every optional dependency (`config`, `glossary`, `memory`, `notes`, `analyst`, `web`, `drafts`, `usage`, `rate_limit`, `hide_my_history`, `can_user_read_report`) with structured `error_code` + `error_detail` logging to `staff_assistant_unanswered` and safe built-in fallbacks. When any tool RPC fails, Zoe retries once with `tools: []` so the model answers in plain text and states plainly what could not be checked. The generic error (`MSG.error`) is reserved strictly for when the AI service itself is unreachable (`ERR_AI_GATEWAY_UNREACHABLE`).
5. **Admin Error Visibility (`staff_assistant_error_summary` + CRM Tab)**: Added `public.staff_assistant_error_summary(p_days integer default 14)` (counts by `error_code` and Kampala day, zero user text) and surfaced it on the CRM review page (`ZoeConversationsPanel.tsx`).
6. **Automated Broken-Database & Plain-Text Fallback Tests**: Added Deno and Vitest tests + evaluation packs covering all 7 missing functions broken one at a time, 20 general questions, and 10 Welile-fact questions with unavailable data.

---

## Fix-by-Fix Breakdown & Proof

### (1) Parity Audit (`docs/zoe/parity-audit.md`)

- **Method**: Queried `information_schema.tables`, `information_schema.columns`, `pg_proc`, `pg_policies`, and `supabase_migrations.schema_migrations` on the linked live database (`npx supabase db query --linked`, read-only).
- **Live Migration Status Confirmed**:
  - **Applied Live (`8` migrations)**: `20261025230000` through `20261027150000`.
  - **Not Yet Applied Live (`4` existing + `1` new migration)**:
    1. `20261028110000_staff_assistant_prompt1_live_fixes.sql`
    2. `20261028150000_staff_assistant_prompt2_brain_memory_glossary.sql`
    3. `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.sql`
    4. `20261029180000_staff_assistant_prompt4_consultant_and_proactive.sql`
    5. `20261030100000_staff_assistant_parity_health_and_error_codes.sql`
- **Confirmed Missing Live Objects**:
  - `staff_assistant_get_config` (created in `20261030100000`)
  - `staff_assistant_can_user_read_report` (existed live with 3-arg signature; `20261028180000` added a conflicting 2-arg overload; unified in `20261030100000` into one canonical `(p_user_id uuid, p_report_rpc text, p_owner_id uuid DEFAULT NULL)` signature)
  - `staff_assistant_save_draft` (created in `20261027120000`, updated in `20261029180000`)
  - `assistant_staff_get_glossary` (created in `20261028150000`)
  - `staff_assistant_hide_my_history` (created in `20261028150000`)
  - `assistant_staff_run_query` (created in `20261028180000`)
  - `assistant_staff_get_data_catalog` (created in `20261030100000`)
  - Extra `staff_assistant_config` columns: `zoe_model_fast`, `zoe_model_deep`, `chat_temperature`, `chat_max_tokens`, `max_cost_ugx_per_question` (`20261028150000`), and `web_research_enabled` (`20261029180000`)

---

### (2) Catch-Up Migration Plan, Rollbacks & Verification SQL (`docs/zoe/deploy-order.md`)

- **Idempotency Fixes**:
  - Fixed `UPDATE public.staff_assistant_config SET ... WHERE id = true;` in `20261028150000_staff_assistant_prompt2_brain_memory_glossary.sql` so Postgres `safeupdate` hooks never reject it.
  - Created `supabase/migrations/20261030100000_staff_assistant_parity_health_and_error_codes.sql` using `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, explicit `REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon`, and `GRANT EXECUTE ON FUNCTION ... TO authenticated`.
- **Rollback Scripts (`supabase/rollbacks/`)**:
  - `20261028110000_staff_assistant_prompt1_live_fixes.rollback.sql`
  - `20261028150000_staff_assistant_prompt2_brain_memory_glossary.rollback.sql`
  - `20261028180000_staff_assistant_prompt3_analyst_lane_zoe_ro.rollback.sql`
  - `20261029180000_staff_assistant_prompt4_consultant_and_proactive.rollback.sql`
  - `20261030100000_staff_assistant_parity_health_and_error_codes.rollback.sql`
- **Verification SQL (`supabase/tests/zoe_live_parity.sql`)**:
  - Asserts all 15 tables, 54 required columns, 19 `zoe_ro.*` views, 111 RPCs, `authenticated` grants, `anon` revocations, `mfa_required_for_staff` RESTRICTIVE RLS policies, and `staff_assistant_health() ->> 'status' = 'ok'`.

---

### (3) Parity Guard (`npm run guard:zoe-parity` & `staff_assistant_health`)

- **Static Build/CI Guard (`scripts/guard-zoe-parity.mjs`)**:
  - Scans all 41 Zoe backend and frontend source files (`supabase/functions/staff-assistant/*.ts`, `staff-assistant-send-email`, `staff-assistant-schedule-runner`, `src/components/zoe/*`, `src/lib/zoe/*`, `src/hooks/useZoeCrm.ts`, `src/components/executive/crm/ZoeConversationsPanel.tsx`).
  - Verifies every referenced table, column, view, RPC, and RPC parameter name exists in `supabase/migrations/`, has `GRANT EXECUTE ... TO authenticated`, has `mfa_required_for_staff`, and is covered by `supabase/tests/zoe_live_parity.sql`.
  -Supports `--live` to run the live database check via `supabase db query --linked` and fail with `"zoe_database_behind"` if any object is missing live.
- **Proof**:
  ```text
  $ node scripts/guard-zoe-parity.mjs
  [guard:zoe-parity] ok — 15 tables, 117 columns, 19 views, and 111 RPCs verified across 41 code files
  ```

---

### (4) Never a Raw Error for a Normal Question (`supabase/functions/staff-assistant/index.ts` & `store.ts`)

- **Optional Dependency Wrapping**:
  - `loadAssistantConfig`: Tries `staff_assistant_get_config()` RPC first, then table read, then falls back to safe built-in defaults (`google/gemini-2.5-flash`, `google/gemini-2.5-pro`, `chat_temperature: 0.2`, `chat_max_tokens: 1800`, `max_cost_ugx_per_question: 150`, `web_research_enabled: false`) while logging `ERR_DB_CONFIG_MISSING` to `staff_assistant_unanswered`.
  - `loadAssistantGlossary`: Wraps `assistant_staff_get_glossary()`, logs `ERR_DB_GLOSSARY_MISSING`, and continues with `[]`.
  - `checkStaffAssistantHealth`: Runs once per 60 seconds and logs `ERR_DB_HEALTH_BEHIND` / `ERR_DB_HEALTH_MISSING` without blocking user answers.
  - `staff_assistant_can_user_read_report`: Logs `ERR_DB_CAN_READ_REPORT_MISSING` and continues when the caller already passed `canUseTool(tool, callerRoles)`.
  - `staff_assistant_save_draft`: Logs `ERR_DB_SAVE_DRAFT_MISSING` and still returns the preview card (`draft_id: null`) so the user sees their draft text.
  - `staff_assistant_hide_my_history`: Logs `ERR_DB_HIDE_HISTORY_MISSING` and falls back to hiding conversations via `staff_assistant_conversations`.
  - `assistant_staff_run_query` & `assistant_staff_get_data_catalog`: Log `ERR_DB_ANALYST_QUERY_MISSING` and `ERR_DB_ANALYST_CATALOG_MISSING` respectively.
- **Tool Failure `tools: []` Plain-Text Retry (`retryPlainTextWhenToolUnavailable`)**:
  - Whenever any tool RPC fails (`ERR_TOOL_RPC_FAILED` / `ERR_DB_ANALYST_QUERY_MISSING` / `ERR_DB_ANALYST_CATALOG_MISSING`), Zoe retries `chatCompletion` once with `tools: []` and a system note listing the unavailable RPC(s) so Zoe answers in plain text and states plainly what could not be checked without inventing figures.
  - `MSG.error` (`"I'm having trouble reading that report right now. Please try again in a moment."`) is returned **only** when the AI gateway itself is unreachable (`ERR_AI_GATEWAY_UNREACHABLE`).

---

### (5) Admin Error Visibility (`staff_assistant_error_summary` & CRM Review Tab)

- **Database RPC**: `public.staff_assistant_error_summary(p_days integer default 14)` returns aggregated `day_kampala`, `error_code`, `reason`, `error_count`, `affected_users`, and `last_seen_at` for CRM / leadership roles (`crm`, `super_admin`, `ceo`, `coo`, `cfo`, `cto`) with **zero user message text**.
- **Frontend UI**: Added `useZoeErrorSummary(days)` in `src/hooks/useZoeCrm.ts` and the **"Error Summary"** tab in `src/components/executive/crm/ZoeConversationsPanel.tsx` with a 7d / 14d / 30d window selector, code badges, and graceful empty/behind states.

---

### (6) Automated Broken-Database & Evaluation Results

All tests ran against the real `handleStaffAssistantRequest` in an isolated in-memory test harness (never touching production):

| Test Suite | Scope | Result |
|---|---|---|
| **7 Missing DB Functions (One at a Time)** | `staff_assistant_get_config`, `staff_assistant_can_user_read_report`, `staff_assistant_save_draft`, `assistant_staff_get_glossary`, `staff_assistant_hide_my_history`, `assistant_staff_run_query`, `assistant_staff_get_data_catalog` | **7 / 7 PASS (100%)** — normal answer returned, no `MSG.error`, exact `error_code` logged |
| **20 General Questions Pack (`GEN-01`..`GEN-20`)** | `"what is receivables"`, `"explain like I'm five how a Rent Plan works"`, `"draft a polite reminder..."`, `"what does iterative mean"`, plus 16 Welile & workplace questions | **20 / 20 PASS (100%)** — answered normally even with all 7 optional DB functions missing |
| **10 Unavailable-Data Welile Questions (`UNAVAIL-01`..`UNAVAIL-10`)** | Arrears ageing, Treasury cash, First 7 Days, Receivables/Payables forecast, October calling report, Landlord verification queue, Supporter Returns, Agent float, Disbursements, Desk wait times | **10 / 10 PASS (100%)** — retried with `tools: []`, named the unavailable RPC, zero invented figures, logged `ERR_TOOL_RPC_FAILED` |
| **AI Unreachable Gate** | `aiGatewayUnreachable: true` | **PASS (100%)** — only case that returns `MSG.error` (`ERR_AI_GATEWAY_UNREACHABLE`) |
| **Full Zoe Live Eval (`npm run eval:zoe:live`)** | 150 data questions + 20 Consultant advice + 20 no-file + 20 prompt-injection + 57 safety + 18 Analyst safety | **100% PASS (0 regressions)** |
