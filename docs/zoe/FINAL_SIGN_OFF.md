# Zoe Staff Assistant — Final Sign-Off & Closing Checklist

**Date:** 2026-11-04  
**Scope:** Single source of truth for Zoe (`staff-assistant`) across every round of work:
1. Initial Gap Review & 4 Prompts (`docs/ZOE_GAP_REVIEW_AND_THREE_PROMPTS.md`)
2. Consolidated Security, Schema-Drift & Capability Review (`docs/ZOE_CONSOLIDATED_REVIEW_AND_ONE_PROMPT.md`)
3. Final Clara Comparison & 3 Closing Prompts (`docs/ZOE_FINAL_CLARA_COMPARISON_AND_THREE_PROMPTS.md`)

Every item below is marked **exactly one of**:
- **`Live and proven`** — deployed in the live database (`project 43e6c2e1-18a6-4503-badb-5bb6c23491cc`) and/or repository, with the exact evidence file, migration, or test suite it points to.
- **`Live, not yet proven`** — code and/or database migration are live and unit-tested, with a plain statement of what real-world production proof is still missing.
- **`Not done`** — not yet changed in live configuration, with the exact blocker and next step explained.

---

## 1. Non-Negotiable Safety & Governance Invariants

| # | Item | Status | Evidence / Explanation |
|---|---|---|---|
| 1.1 | **Read-only business-data invariant (CEO rule)** — Zoe writes only to `staff_assistant_*` tables; emails, reminders, notifications, schedules, and ideas execute only after a person clicks confirm | **Live and proven** | `scripts/guard-zoe-readonly.mjs`, `supabase/functions/staff-assistant/index.ts`, `supabase/migrations/20261103193000_zoe_consolidated_hardening_and_parity.sql` (`zoe_readonly_exec` role revoke matrix), `src/lib/zoe/__tests__/zoeConsolidatedCapabilities.test.ts` |
| 1.2 | **Clara untouched** — `supabase/functions/agent-assistant/`, `src/components/agent/AgentAssistant.tsx`, `src/assets/clara-avatar.png`, and `assistant_*` (`persona = 'agent'`) were studied read-only and never modified | **Live and proven** | Verified via `git diff` across all Zoe commits; Clara files remain untouched |
| 1.3 | **Schema-drift reconciliation & migration parity guard** — every Zoe table, column, view, and function verified against live `information_schema` / `pg_proc` and committed under `supabase/migrations/` | **Live and proven** | `docs/zoe/schema-drift-reconciliation.md`, `scripts/guard-zoe-migration-parity.mjs`, `supabase/migrations/20261031120000_zoe_reconcile_live_schema_drift.sql` |
| 1.4 | **MFA & least-privilege grants on `staff_assistant_*` tables and functions** — `mfa_required_for_staff` restrictive policy on all 21 `staff_assistant_*` tables, `EXECUTE` granted to `authenticated` only, `(SELECT auth.uid())` wrapped in policies | **Live and proven** | `supabase/migrations/20261103193000_zoe_consolidated_hardening_and_parity.sql`, `docs/zoe/security-verification.md` |
| 1.5 | **Welile regulatory terminology & exact money formatting** — mandatory `"Rent Plan"`, `"Supporter"`, `"Returns"`; money formatted as `"UGX 1,234"` copied verbatim from tool results and checked by the figure verifier | **Live and proven** | `supabase/functions/staff-assistant/prompt.ts`, `supabase/functions/staff-assistant/verifier.ts`, `src/lib/zoe/__tests__/zoeRealHandler.test.ts` |

---

## 2. Prompt 1 — Voice, Face, Refusal Wording, and Greeting Presence

| # | Item | Status | Evidence / Explanation |
|---|---|---|---|
| 2.1 | **Voice and personality rewrite** — warm, plain-spoken, helpful colleague suited to an office workspace, keeping every rule on money, roles, and read-only behaviour word for word | **Live and proven** | `supabase/functions/staff-assistant/prompt.ts` (` PERSONALITY & VOICE` section), `docs/zoe/voice-and-face-15-conversations.md`, `src/lib/zoe/__tests__/zoeVoiceAndFace15Conversations.test.ts` |
| 2.2 | **"Read the room" rule** — explicit prompt section forbidding light or celebratory language in the same reply as a failed payment, arrears/complaint, disciplinary matter, error, or refusal | **Live and proven** | `supabase/functions/staff-assistant/prompt.ts` (`READ THE ROOM (MANDATORY TONE GUARD)` section), `src/lib/zoe/__tests__/zoeVoiceAndFace15Conversations.test.ts` |
| 2.3 | **Refusal wording (`REFUSE: <kind sentence>`)** — retired bare `ROLE_RESTRICTED`, `OUT_OF_SCOPE`, and `UNMATCHED` code words as user-facing model output; Zoe writes her own specific, kind refusal sentence while the server still logs structured outcomes and routes `UNMATCHED` to `staff_assistant_unanswered` | **Live and proven** | `supabase/functions/staff-assistant/index.ts` (`parseRefusalPrefixAndOutcome`), `supabase/functions/staff-assistant/prompt.ts`, `docs/zoe/voice-and-face-15-conversations.md` (Conversations 10–12) |
| 2.4 | **Human face (`zoe-avatar.svg`) and launcher presence** — warm Ugandan office colleague portrait (`src/assets/zoe-avatar.svg`), `"Ask Zoe"` label, subtle breathing pulse when idle, and a once-per-My-Space-visit dismissible greeting bubble (`sessionStorage`) | **Live and proven** | `src/assets/zoe-avatar.svg`, `src/components/zoe/ZoeFloatingLauncher.tsx`, `src/components/zoe/__tests__/ZoeFloatingLauncher.test.tsx` |
| 2.5 | **15 real staff conversation transcripts reviewed before/after** — 5 greetings/small-talk, 5 data questions, 3 refusals, 2 error/problem turns | **Live and proven** | `docs/zoe/voice-and-face-15-conversations.md`, `src/lib/zoe/__tests__/zoeVoiceAndFace15Conversations.test.ts` |

---

## 3. Prompt 2 — Models, Evaluation Harness, Drift Check, Analyst Lane & Scheduled Reports

| # | Item | Status | Evidence / Explanation |
|---|---|---|---|
| 3.1 | **Real evaluation harness (`npm run eval:zoe:real`) & multi-model candidate support (`ZOE_EVAL_MODELS`)** — zero-simulation runner that authenticates as `[ZOE_TEST]` accounts and writes dated request/response logs and `summary.json` | **Live and proven** | `scripts/zoe-eval/run-real-eval.mjs`, `docs/zoe/test-accounts.md`, `docs/zoe/eval-real/2026-11-04/summary.json`, `docs/zoe/prompt2-brain-and-eval-results.md` |
| 3.2 | **Real evaluation passed with actual live numbers (`npm run eval:zoe:real`)** | **Not done** | **Why:** Blocked on owner creation of the 7 `[ZOE_TEST]` staff accounts (`zoe.eval.employee@welile.com`, `zoe.eval.tenant_ops@welile.com`, `zoe.eval.landlord_ops@welile.com`, `zoe.eval.agent_ops@welile.com`, `zoe.eval.cfo@welile.com`, `zoe.eval.hr@welile.com`, `zoe.eval.crm@welile.com`) and `.env.zoe-eval.local` credentials per `docs/zoe/test-accounts.md`. Per project rules, no accounts were created by the assistant and no numbers were simulated (`docs/zoe/eval-real/2026-11-04/summary.json` records `status: "not_run"`). |
| 3.3 | **Model re-pinning in `staff_assistant_config` (`model_fast`, `model_deep`) from real evaluation numbers** | **Not done** | **Why:** Live `staff_assistant_config` currently holds `model_fast = 'google/gemini-2.5-flash'` and `model_deep = 'google/gemini-2.5-pro'`, while the Lovable AI gateway is routing live turns to `gemini-3.8-flash` (34/35 recent replies). Re-pinning `model_fast` and `model_deep` is gated on running `ZOE_EVAL_MODELS="google/gemini-3.8-flash,google/gemini-2.5-flash-lite,google/gemini-2.5-pro" npm run eval:zoe:real` once the 7 `[ZOE_TEST]` accounts in item 3.2 exist. |
| 3.4 | **Model drift check running (`staff_assistant_check_model_drift`) & admin warning banner** — compares `requested_model` vs `gateway_model` across the last 50 replies (`staff_assistant_messages`) and surfaces an amber warning banner in the admin console whenever gateway routing diverges from `staff_assistant_config` | **Live and proven** | `supabase/migrations/20261104190000_staff_assistant_model_drift_check.sql` (applied live & verified detecting 34/35 `gemini-3.8-flash` drift), `src/components/executive/crm/ZoeConversationsPanel.tsx` (`data-testid="zoe-model-drift-warning-banner"`), `src/lib/zoe/__tests__/zoeModelDriftAndAnalystOffer.test.ts` |
| 3.5 | **Analyst lane (`run_analyst_query` over 22 `zoe_ro.*` views) openly offered in prompt & UI** — prompt instructs Zoe to proactively use `run_analyst_query` or offer `"Would you like me to check the custom breakdown for that?"` when a named RPC does not cover a slice | **Live, not yet proven** | `supabase/functions/staff-assistant/prompt.ts`, `supabase/functions/staff-assistant/analyst.ts`, `src/lib/zoe/__tests__/zoeModelDriftAndAnalystOffer.test.ts`. **What proof is still missing:** In production (`staff_assistant_messages`), `analyst_used = true` has `0` live staff turns recorded so far; real-world proof requires live staff or the `[ZOE_TEST]` evaluation run to execute `run_analyst_query` in production. |
| 3.6 | **Web research (`search_web`, `read_web_page`) enabled and proven in live chat** | **Not done** | **Why:** The web research tools, domain safety allowlist/blocklist, and `staff_assistant_research_logs` audit table are deployed (`supabase/functions/staff-assistant/research.ts`), but `staff_assistant_config.web_research_enabled` is still `false` in the live database (`0` rows in `staff_assistant_research_logs`) pending a configured search API key (`BRAVE_SEARCH_API_KEY` / `SERPER_API_KEY` / `TAVILY_API_KEY`) in Supabase Edge Function secrets. |
| 3.7 | **Scheduled reports & reminders sending (`zoe-scheduled-dispatcher`)** — Edge Function logic, Kampalan window matching, and dry-run/unit verification for `staff_assistant_schedules` and `staff_assistant_reminders` | **Live, not yet proven** | `supabase/functions/zoe-scheduled-dispatcher/index.ts`, `src/lib/zoe/__tests__/zoeModelDriftAndAnalystOffer.test.ts`, `docs/zoe/prompt2-brain-and-eval-results.md`. **What proof is still missing:** Live database currently has `1` active schedule (`last_run_at = null`) and `1` pending reminder (`delivered_at = null`); a live cron firing of `zoe-scheduled-dispatcher` in production has not yet stamped a non-null `last_run_at` / `delivered_at`. |

---

## 4. Prompt 3 — Adoption Push, Weekly Adoption Dashboard, and Final Baseline

| # | Item | Status | Evidence / Explanation |
|---|---|---|---|
| 4.1 | **"Meet the new Zoe" adoption notice shown once in My Space** — shown once per staff member (`localStorage` key `welile.zoe.meet_new_zoe_seen.v1:<user_id>`) the first time they open My Space after release, with a one-tap `"Ask Zoe now"` button and a two-line note for managers | **Live and proven** | `src/components/zoe/MeetTheNewZoeBanner.tsx`, `src/components/layout/PersonalLayout.tsx`, `src/components/zoe/__tests__/ZoeAdoptionPush.test.tsx` |
| 4.2 | **8–10 example questions on Zoe's empty-chat screen pulled from Clara & `staff_assistant_unanswered`** — 10 clickable questions visible immediately on Zoe's empty-chat screen (`data-testid="zoe-empty-chat-examples"`), plus the two-line note to managers (`data-testid="zoe-empty-chat-manager-note"`) | **Live and proven** | `src/components/zoe/zoeConfig.ts` (`ZOE_EMPTY_CHAT_EXAMPLE_QUESTIONS`, `ZOE_MANAGER_ADOPTION_NOTE_LINES`), `src/components/zoe/ZoeChatSurface.tsx`, `src/components/zoe/__tests__/ZoeAdoptionPush.test.tsx` |
| 4.3 | **Plain weekly adoption number & 8-week trend line on the manager usage dashboard (`staff_assistant_real_use_dashboard`)** — returns `weekly_active_staff`, `baseline_weekly_active_staff` (`1`), and `weekly_adoption_trend` (8-week series), rendered with a headline count and SVG trend line | **Live and proven** | `supabase/migrations/20261104233000_staff_assistant_weekly_adoption_trend.sql` (applied & verified live in `schema_migrations`), `src/hooks/useZoeCrm.ts`, `src/components/executive/crm/ZoeConversationsPanel.tsx` (`data-testid="zoe-weekly-adoption-card"`, `data-testid="zoe-weekly-adoption-trend"`) |
| 4.4 | **210-entry knowledge base (`staff_assistant_knowledge_base`) & Department Lead teaching queue (`staff_assistant_teach_from_review_queue`)** | **Live and proven** | `supabase/migrations/20261030180000_zoe_consultant_eval_and_kb_200.sql` (210 active rows verified live), `supabase/migrations/20261103193000_zoe_consolidated_hardening_and_parity.sql` |

---

## 5. One Real Number to End On — Weekly Staff Adoption

Per Prompt 3 Deliverable (4), the single real-world measure of whether Zoe is genuinely useful to Welile staff is **distinct staff who used Zoe at least once in the last 7 Kampala days** (`staff_assistant_real_use_dashboard` → `weekly_active_staff`).

| Measurement Milestone | Date | Distinct Staff Using Zoe (Last 7 Days) | Total All-Time Distinct Staff | Source / Notes |
|---|---:|---:|---:|---|
| **Baseline (before this round of work began)** | `2026-11-04` | **1** | **2** | Verified live from `public.staff_assistant_messages` (`SELECT count(DISTINCT user_id) WHERE created_at >= now() - interval '7 days'`) |
| **Two-week post-ship check-in** | `2026-11-18` *(scheduled)* | *Read live from `staff_assistant_real_use_dashboard(14)` → `weekly_active_staff`* | *Read live from `staff_assistant_real_use_dashboard(14)`* | **Success criterion:** `weekly_active_staff > 1` and rising on `weekly_adoption_trend` |

### How to Record the 2026-11-18 Check-In
On or after **18 November 2026**, open **Executive Hub → CRM → Zoe Conversations → Real-Use Dashboard** (or run `SELECT public.staff_assistant_real_use_dashboard(14);`) and copy `weekly_active_staff` and the latest bucket of `weekly_adoption_trend` into the row above.
