# Zoe Part B — Reliability Results & Honest Production Telemetry (`docs/zoe/reliability-results.md`)

**Date:** 2026-11-03 (Africa/Kampala)  
**Rule Enforced:** No simulated numbers in any results document. Anything not run for real with dedicated test staff accounts is explicitly marked **`not run`**.

---

## 1. Real Production Telemetry Snapshot (Verified Against Live Database `43e6c2e1-18a6-4503-badb-5bb6c23491cc`)

Prior to Part B, live production (`public.staff_assistant_messages`, `public.staff_assistant_unanswered`, `public.staff_assistant_learning_log`) contained the following real turns recorded between **2026-10-29** and **2026-11-03**:

| Metric (Live Production `staff_assistant_real_use_dashboard(30)`) | Real Value in Live DB | Notes |
|---|---|---|
| Total real conversations | `1` | Single staff user session since 2026-10-29 |
| Total user questions (`role = 'user'`) | `8` | Asked between 2026-10-29 and 2026-10-30 |
| Total assistant replies (`role = 'assistant'`) | `8` | `3` answered (`37.5%`), `3` error (`37.5%`), `2` out_of_scope (`25.0%`) |
| Unanswered / error queue rows (`staff_assistant_unanswered`) | `5` | `3` reason=`error`, `2` reason=`out_of_scope` (`error_code` was `null` on pre-Part-B rows) |
| Learning log rows (`staff_assistant_learning_log`) | `8` | Backfilled/recorded from the 8 real turns |
| Positive / Negative thumbs (`staff_assistant_feedback`) | `0` up / `0` down | No thumbs tapped yet in live production |

### Root Causes Identified in the 8 Real Turns & Fixed in Part B

1. **Wrong-question bug (Turn 8 — `"good morning"` answered an earlier Tenant Ops question)**:
   - **Cause**: When building model context (`loadRecentTurns`), turns whose outcome was `error` or `blocked` / `out_of_scope` (and any orphan user turn) remained in the conversation window sent to the model. When the user sent `"good morning"` after failed/refused turns, the model answered the earlier unanswered question from history instead of the greeting.
   - **Fix (`supabase/functions/staff-assistant/store.ts` & `index.ts`)**:
     - Added `filterCleanModelHistory(chronologicalRows)` which strips any turn pair whose assistant outcome is in `EXCLUDED_CONTEXT_OUTCOMES` (`error`, `blocked`, `out_of_scope`, `not_staff`, `missing_tool`, `unmatched`, `rate_limited`) or whose assistant text is a refusal/error constant, while keeping all rows in `public.staff_assistant_messages` storage.
     - Added `formatCurrentUserMessageForModel(userText)` which places the newest user message last and marks it explicitly with `[ANSWER THIS MESSAGE]\n<message>`.
     - Applied the same clean-history filter and `[ANSWER THIS MESSAGE]` marker to normal turns, streamed turns (`stream: true`), tool-unavailable retry turns, and Regenerate turns.
     - Verified with unit & handler regression tests in `src/lib/zoe/__tests__/zoeRealHandler.test.ts` (`14/14` passing).

2. **Model Pinning & Telemetry (`requested_model`, `gateway_model`, `ttfb_ms`, `error_code`)**:
   - **Cause**: Pre-Part-B rows in `staff_assistant_messages` had `model: "google/gemini-3-flash-preview"` without recording `requested_model` vs `gateway_model`, `ttfb_ms`, or a guaranteed non-null `error_code` on failures.
   - **Fix (`supabase/functions/staff-assistant/openai.ts`, `store.ts`, `index.ts`)**:
     - Fast tier is pinned to `google/gemini-2.5-flash` and deep tier to `google/gemini-2.5-pro` via `public.staff_assistant_config` (`model_fast`, `model_deep`).
     - Every turn records `requested_model`, `gateway_model`, `ttfb_ms` (measured at first streamed token or first gateway response), `latency_ms`, `cost_usd`, `analyst_used`, `research_used`, and a guaranteed non-null `error_code` (`defaultErrorCodeForOutcome`) whenever a turn is not `answered` / `clarify`.

3. **Existing Simulator Files Marked `"simulated, not release proof"`**:
   - Marked `docs/zoe/eval-results/release-200-2026-10-30.md`, `docs/zoe/prompt1-results.md`, `docs/zoe/prompt3-results.md`, `docs/zoe/prompt4-results.md`, and `docs/zoe/test-results.md` at the top with a prominent notice that their numbers come from the local simulator (`npm run eval:zoe`) and are **simulated, not release proof**.

4. **Scheduled Runner Status (`supabase/functions/staff-assistant-schedule-runner/index.ts`)**:
   - The edge function `staff-assistant-schedule-runner` is implemented and wired to `public.staff_assistant_claim_due_schedules(20)` and `public.staff_assistant_complete_schedule_run(...)`.
   - In `public.staff_assistant_schedules`, there are currently `0` active scheduled runs created by staff; pg_cron trigger activation remains off until the owner enables outbound scheduled emails in production.

---

## 2. Live End-to-End Evaluation (`npm run eval:zoe:real`) Status

Per Part B item (2):
- Created [`docs/zoe/test-accounts.md`](./test-accounts.md) with step-by-step instructions for the owner to create and flag dedicated test staff accounts (`employee`, `operations`, `partner_ops`, `cfo`, `coo`, `ceo`, `hr`) and pass `ZOE_EVAL_TEST_ACCOUNTS_JSON` at runtime. Agents never create staff accounts or mint tokens themselves.
- Built [`scripts/eval-zoe-real.mjs`](../../scripts/eval-zoe-real.mjs) (`npm run eval:zoe:real` in `package.json`) with the 120 core evaluation questions (40 general, 40 staff-record, 20 advice & research, 20 safety).
- Executed `npm run eval:zoe:real` on `2026-11-03` (`docs/zoe/eval-real/2026-11-03/summary.json`). Because `ZOE_EVAL_TEST_ACCOUNTS_JSON` is not present in the local build environment, the live HTTP run is honestly recorded as **`not run`**:

| Release Gate Metric (`npm run eval:zoe:real`) | Target Bar | Real Run Status (2026-11-03) |
|---|---|---|
| Raw errors on general questions (40) | `0` | `not run` (requires owner-created `ZOE_EVAL_TEST_ACCOUNTS_JSON`) |
| Raw errors on staff-record questions (40) | `0` | `not run` (requires owner-created `ZOE_EVAL_TEST_ACCOUNTS_JSON`) |
| Figure mismatches vs official report RPC | `0` | `not run` (requires owner-created `ZOE_EVAL_TEST_ACCOUNTS_JSON`) |
| Wrong-question replies after failed/blocked turn | `0` | `0` in handler regression test (`zoeRealHandler.test.ts`); live HTTP run: `not run` |
| Safety / role / write / injection leaks (20) | `0` | `not run` (requires owner-created `ZOE_EVAL_TEST_ACCOUNTS_JSON`) |
| Median / p95 time to first word (`ttfb_ms`) | `< 2,500 ms` / `< 6,000 ms` | `not run` (requires owner-created `ZOE_EVAL_TEST_ACCOUNTS_JSON`) |
