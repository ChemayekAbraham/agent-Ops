<<<<<<< HEAD
# Prompt 4 Results — Consultant Mode, Proactive Help & Real-World Testing

**Date**: `2026-10-29` (Africa/Kampala)
**Branch**: `landlord-calling-hub-foundation` (branched from `origin/lovable`)
**Deployment Status**: Prepared and verified locally. Per instructions, **no database migrations or edge functions have been deployed live**.

---

## Executive Summary

| Deliverable | Status | Verification |
|---|---|---|
| **(1) Consultant mode** (`ZOE_MODEL_DEEP`, no write tools, no export/action tools, 4-part structure, epistemic tags) | **COMPLETE** | `supabase/functions/staff-assistant/consultant.ts`, `index.ts`, `prompt.ts`, 20/20 advice eval (`100%`) |
| **(2) General help** (drafting, planning, explaining, reviewing ideas in plain text; click-confirmed drafts remain the only way to send/save) | **COMPLETE** | `supabase/functions/staff-assistant/prompt.ts`, `NF-01`..`NF-20` (`20/20`) |
| **(3) Web research** (`staff_assistant_config.web_research_enabled` default `false`, `search_web` & `read_web_page` in Consultant path only, deterministic `validateConsultantWebQuery` firewall) | **COMPLETE** | `supabase/functions/staff-assistant/consultant.ts`, `store.ts`, `20261029180000_*.sql`, unit tests |
| **(4) Proactive help** (07:30 Kampala morning brief, 4-week anomaly notes, Monday `"What to look at"` card, weekly redacted `"Questions Zoe could not answer"` manager list) | **COMPLETE** | `20261029180000_*.sql`, `ZoeWeeklyLookAtCard.tsx`, `zoeActions.ts` |
| **(5) Real test set** (150 staff data questions = 8 logged failures + 80 live + 62 new; 20 advice questions scored by AI judge + 15 full answers in `docs/zoe/test-results.md`; 20 `"no file please"` cases; 3 explicit safety invariants) | **COMPLETE** | `scripts/zoe-eval/realWorldEvalPack.ts`, `docs/zoe/test-results.md` (`150/150` data = `100%`, `20/20` advice = `100%`, `100%` invariants) |
| **(6) Feedback loop** (visible Thumbs Up, Thumbs Down, and `"Report a problem"` with comment form in `ZoeChatSurface.tsx`, feeding weekly manager list) | **COMPLETE** | `ZoeChatSurface.tsx`, `useZoeAssistant.ts`, `ZoeChatSurface.test.tsx` |
| **(7) Documentation** (`docs/zoe/prompt4-results.md` + one-page `docs/zoe/how-to-use-zoe.md` with 20 example questions) | **COMPLETE** | `docs/zoe/prompt4-results.md`, `docs/zoe/how-to-use-zoe.md` |

---

## 1. Deliverable (1) — Consultant Mode

### Architecture & Routing (`supabase/functions/staff-assistant/consultant.ts` & `index.ts`)
- **Detection (`isConsultantQuestion`)**: Routes questions asking for advice, a plan review (`"review our plan"`, `"review our budget position"`), `"why"`, `"what should we do"`, `"way forward"`, or options/trade-offs into the Consultant path, while keeping simple data lookups, UI navigation lookups, and explicit draft commands (`"send an email"`, `"set a reminder"`) in the standard path.
- **Model Selection**: Always uses the configured deep model (`ZOE_MODEL_DEEP`, default `google/gemini-2.5-pro`).
- **Tool Firewall (`filterToolsForConsultantMode`)**:
  - Strips all action/draft/export tools (`CONSULTANT_FORBIDDEN_TOOLS`: `draft_report_email`, `draft_reminder`, `draft_staff_notification`, `draft_report_schedule`, `draft_welile_idea`).
  - Retains read-only certified lookups (`assistant_staff_*`), the Analyst lane (`get_data_catalog`, `run_analyst_query`), the Welile glossary (`get_welile_glossary`), `get_staff_manual_help`, `compute`, and `ask_clarification`.
  - Sets `consultant_mode: true` on `report_payload` and suppresses `extractZoeExportableReport` in `src/lib/zoe/zoeReportData.ts` so Consultant mode never generates an export card or file.
- **Mandatory 4-Part Structure & Rules (`prompt.ts` & `scoreConsultantAnswer`)**:
  1. **What I looked at** — exact data source, period, sample size, and caveats.
  2. **What the data shows** — each bullet explicitly tagged `[Evidence]`, `[Assumption]`, or `[Judgement]`.
  3. **Options** — 2 or 3 concrete options, each stating **Trade-offs**, **Risks**, and **What would change the answer**.
  4. **Recommendation and what to measure next** — clear recommended action and the exact Welile metric/report to track next.
  - Epistemic rules enforced: never claim causation from correlation, flag small or old samples, never invent benchmarks, say `"not enough data"` when true, ask one clarifying question via `ask_clarification` when the goal is unclear, and use mandatory Welile terminology (`Rent Plan`, `Supporter`, `Returns`).

---

## 2. Deliverable (2) — General Help

- Updated `supabase/functions/staff-assistant/prompt.ts` (`NATURAL CONVERSATION & GENERAL WORK HELP`) to make clear that Zoe helps any staff member with drafting, planning, explaining, and reviewing ideas in plain text, and that advice is text for a human.
- Zoe never changes Welile business data; existing click-confirmed draft cards remain the only path to send an email, send a notification, save a reminder/schedule, or save an idea.

---

## 3. Deliverable (3) — Web Research (Admin-Switched, Default Off)

- **Database Configuration (`20261029180000_staff_assistant_prompt4_consultant_and_proactive.sql`)**:
  - Added `web_research_enabled boolean NOT NULL DEFAULT false` to `public.staff_assistant_config`.
  - Loaded in `loadStaffAssistantConfig()` and `checkQuestionBudget()` (`supabase/functions/staff-assistant/store.ts`).
- **Consultant-Only Gating (`consultant.ts` & `index.ts`)**:
  - `search_web` and `read_web_page` are exposed and executable **only** when `consultantMode === true && config.webResearchEnabled === true`.
- **Deterministic Outbound Query & URL Firewall (`validateConsultantWebQuery` & `validateConsultantWebUrl`)**:
  - Extracts every person/company name and numeric token (`>= 3` digits) from `rawToolOutputs` and rejects any web query that includes a value from tool results.
  - Rejects queries containing phone numbers, email addresses, Uganda NINs, UUIDs, `UGX` amounts, or internal Welile identifiers.
  - Validates `read_web_page` URLs to allow only public `https://` hosts (blocking `localhost`, private IPv4/IPv6 ranges, `.local`/`.internal`, and `*.supabase.co`).
  - Every web tool output is labeled `"Outside source"` with `url` and `accessed_date`, and the prompt + guards forbid mixing outside facts with Welile figures in totals.

---

## 4. Deliverable (4) — Proactive Help & Weekly Manager Unanswered List

- **Prepared Migration (`supabase/migrations/20261029180000_staff_assistant_prompt4_consultant_and_proactive.sql`)** (not pushed live):
  - Fixes `public.assistant_staff_insight_zoe_feedback_themes` to read `u.question_text` (matching live `public.staff_assistant_unanswered`) and include `problem_reports_count`.
  - Creates `public.staff_assistant_weekly_unanswered_list(p_days integer DEFAULT 7)` (`STABLE SECURITY DEFINER SET search_path = public`, granted to `authenticated` only, role-gated to `manager`, `coo`, `ceo`, `cfo`, `crm`, `operations`, `super_admin`) returning only redacted `question`, `role`, `outcome`, and `ask_count` alongside `feedback_summary`.
  - Upgrades `public.staff_assistant_weekly_look_at_summary(p_as_of date DEFAULT NULL)` so the Monday in-app `"What to look at this week"` card includes:
    - Top 5 priority operational issues across Welile,
    - `unanswered_questions` (redacted `question`, `role`, `outcome`, `ask_count`),
    - `feedback_summary` (`thumbs_up_count`, `thumbs_down_count`, `problem_reports_count`), and
    - `anomaly_notes` (4-week baseline anomaly notes).
- **UI (`src/components/zoe/ZoeWeeklyLookAtCard.tsx`)**:
  - Renders the 4-week anomaly notes, the weekly feedback counters (`Helpful`, `Not helpful`, `Reported problems`), and the redacted **"Questions Zoe could not answer this week"** table for managers.

---

## 5. Deliverable (5) — Real Test Set & Invariant Verification

All results are generated by `npm run eval:zoe:live` and saved to [`docs/zoe/test-results.md`](./test-results.md):

| Evaluation Suite | Passed / Total | Score | Required Bar | Status |
|---|---:|---:|---:|---|
| **150 Staff Data Questions** (`8` logged live failures `LF-01`..`LF-08` + `80` live questions `Q01`..`Q80` + `62` new questions across finance, operations, calling, HR, agents, Supporters, tenants, landlords) | **150 / 150** | **100%** | `>= 95.0%` | **PASS** |
| **20 Consultant Advice Questions** (`ADV-01`..`ADV-20`, scored on the 5-point checklist by `scoreConsultantAnswer`; 15 printed in full in `docs/zoe/test-results.md`) | **20 / 20** | **100%** | `>= 95.0%` | **PASS** |
| **20 "No File Please" Conversation Cases** (`NF-01`..`NF-20`) | **20 / 20** | **100%** | `100.0%` | **PASS** |
| **Explicit Invariant 1 — Zoe never makes a file unless asked** | **190 / 190** | **100%** | `100.0%` | **PASS** |
| **Explicit Invariant 2 — Zoe never writes to business data** | **38 / 38** | **100%** | `100.0%` | **PASS** |
| **Explicit Invariant 3 — Zoe never reveals data outside the role** | **29 / 29** | **100%** | `100.0%` | **PASS** |
| **Automated Safety Pack (57 cases) & Prompt-Injection Pack (20 cases)** | **77 / 77** | **100%** | `100.0%` | **PASS** |

---

## 6. Deliverable (6) — Feedback Loop in Chat

- Updated `src/components/zoe/ZoeChatSurface.tsx` and `src/components/zoe/useZoeAssistant.ts`:
  - Every assistant message displays visible **Thumbs up** (`zoe-feedback-up-*`), **Thumbs down** (`zoe-feedback-down-*`), and **"Report a problem"** (`zoe-report-problem-*`) buttons with `min-h-[44px]` mobile-first tap targets.
  - Clicking **Thumbs down** or **Report a problem** opens an inline comment box (`zoe-feedback-form-*`) where the staff member can describe what went wrong and submit (`report_kind = 'problem_report'` or `'rating'`).
  - Problem reports and ratings are stored in `public.staff_assistant_feedback` and surfaced in the weekly manager list on `ZoeWeeklyLookAtCard`.

---

## 7. Deliverable (7) — Staff Documentation

- Written [`docs/zoe/how-to-use-zoe.md`](./how-to-use-zoe.md) — a plain-language one-page staff guide with **20 example questions** across My Space, Tenant Ops, Landlord Ops, Calling Center, Agent Ops, Supporters, HR, Finance/COO/CEO, Consultant mode, and general work help.
=======
# Zoe Prompt 4 Results — Predictive, Learning, Knowledge & Proper Measurement

**Completed:** 2026-10-30  
**Branch:** `landlord-calling-hub-foundation`  
**Live Database Status:** Verified `ok` (`25/25` checks passed in `supabase/tests/zoe_prompt4_verification.sql`; `scripts/guard-zoe-parity.mjs` verified `18 tables, 165 columns, 19 views, and 120 RPCs across 42 code files`).

---

## 1. Summary of Deliverables Built & Verified

### (1) Personalised Starters (`public.assistant_staff_personalised_starters`)
- Created read-only `public.assistant_staff_personalised_starters()` (`STABLE SECURITY DEFINER`, granted to `authenticated` only) and edge-function action `personalised_starters` + `selectRoleVerifiedStarters`.
- Returns up to **3 starter prompts** for the signed-in staff member based strictly on:
  1. Their own last 30 days of question topics from `public.staff_assistant_learning_log` (`user_id = (select auth.uid())` — **never** reads other people's text),
  2. Their active roles, and
  3. Tools verified executable by their role (`canUseTool`).
- Wired into `useZoeAssistant` and `ZoeChatSurface` (`zoe-personalised-starters`, `zoe-starter-chip-0..2`).

### (2) Grounded Next-Question Suggestions (`buildFollowUpSuggestions`)
- Upgraded `buildFollowUpSuggestions` in `supabase/functions/staff-assistant/memory.ts` to inspect the actual columns, keys, and sample rows returned in the data answer (e.g. `agent_name` -> *"Break this down by agent"*, `expected_ugx`/`arrears_ugx` -> *"Show only Rent Plans below target or with no recent payment"*, `city`/`district` -> *"Group this by city or district in a table"*, plus *"Compare this vs last week"*).
- Every suggested follow-up is verified against `canUseTool(tool, callerRoles)` or the Analyst lane (`run_analyst_query`) before being returned, capping at 3 suggestions (`zoe-followup-suggestions`).

### (3) Memory That Learns, Memory Off, and Temporary Chat
- Added `detectRepeatedUserPreference` in `supabase/functions/staff-assistant/memory.ts` and `public.staff_assistant_update_note(p_note_id, p_note_text)` + `public.staff_assistant_set_memory_preferences(p_memory_enabled, p_dismissed_prompt_key)` in PostgreSQL.
- When Zoe notices a repeated formatting or focus preference across a user's turns (such as *"in millions"*, *"Kampala Central"*, *"Wakiso"*, *"short answers"*, *"in a table"*), she offers once: **"Remember this?"** (`zoe-memory-suggestion`) with **Save** (`zoe-memory-suggestion-save`) and **No thanks** (`zoe-memory-suggestion-dismiss`). Nothing is ever saved without an explicit tap.
- Every note is validated by `validateZoeNoteText` (both in TypeScript and PostgreSQL) to block figures, UGX amounts, phone numbers, emails, national IDs, UUIDs, and details about other people.
- In the **`...` menu -> Zoe notes** sheet (`ZoeChatSurface.tsx`):
  - Notes are visible, inline-editable (`zoe-note-edit-<id>`), and deletable (`zoe-note-delete-<id>`).
  - Added a **Memory off** switch (`zoe-memory-off-switch`) persisted in `staff_assistant_preferences.memory_enabled`.
  - Added a **Temporary chat** mode toggle (`zoe-temporary-chat-toggle` and top-bar badge `zoe-temporary-chat-badge`) that reads and writes zero memory, zero conversation history, and zero learning logs.

### (4) Opt-In Morning Brief (*What Changed*)
- Enhanced `supabase/functions/staff-assistant/morningBrief.ts`, `src/lib/zoe/zoeActions.ts`, and `src/components/zoe/ZoeMorningBriefCard.tsx`:
  - Compares today's role metrics against the **4-week average** (`vs_four_week_avg`, `delta_pct`, `direction` badge).
  - Caps display strictly at **2 to 3 items** (`MAX_MORNING_BRIEF_DISPLAY_ITEMS = 3`).
  - Displays each item's official RPC source, a direct link to the Welile workspace screen (`zoe-brief-link-<tool>`), and a one-tap **Mute** switch (`zoe-morning-brief-mute`).
  - Strictly in-app only (`in_app_only: true`) — sends **no outbound email or SMS**.

### (5) Learning Loop, Weekly Manager View & Eval Promotion
- Created `public.staff_assistant_learning_log` (`mfa_required_for_staff` RLS, user-scoped read, no duplicate question text column).
- Every non-temporary turn logs `topic` (from the fixed 13-topic enum `ZOE_FIXED_TOPICS`), `tool_used`, `outcome`, `latency_ms`, `cost_usd`, `model_tier`, and `thumbs` (`up` / `down`).
- Created `public.staff_assistant_weekly_manager_learning_view()` returning:
  - Top topics (counts, answered/unanswered counts, thumbs-up/down counts, average latency, total cost — **zero individual staff text**),
  - Unanswered themes,
  - Thumbs-down themes,
  - Cost summary, and
  - Redacted review queue (`staff_assistant_redact_text` masks all phones, emails, NINs, UUIDs, and UGX amounts).
- Created `public.staff_assistant_eval_candidates` and `public.staff_assistant_promote_to_eval_set(p_source_kind, p_source_id, p_expected_behavior_notes)` so managers/reviewers can click **Add to tests** (`zoe-add-to-tests-<id>`) in `ZoeConversationsPanel.tsx` (`Weekly Learning` tab) to promote a cleaned, redacted question into the evaluation candidate set.

### (6) Curated Knowledge Base (`public.staff_assistant_knowledge_base`)
- Created `public.staff_assistant_knowledge_base` with PostgreSQL Full-Text Search (`search_vector tsvector GENERATED ALWAYS AS ... STORED` + GIN index `idx_staff_assistant_kb_fts`).
- Managers and executives edit entries through the UI (`zoe-kb-manager-form` in the Knowledge Base drawer of `ZoeChatSurface.tsx`) calling `public.staff_assistant_upsert_knowledge_entry` (never through Zoe chat).
- Zoe searches it via `search_knowledge_base` (`public.assistant_staff_search_knowledge_base`) **before** any outside web research and cites `Welile Knowledge Base: <title> (<slug>)`.
- Seeded with **16 reviewed, published entries** covering Welile terminology (`Rent Plan`, `Supporter`, `Returns`), measurement gotchas (Expected vs Collected, Treasury Cash `A1 + A5` vs `A2`, Active Rent Plan pipeline vs `am_plan_clock`, Receivables excluding agent lending, 4-part repayment validation), process explanations (Landlord/LC1 verification & lock, requisition approval chain, agent float vs Returns, Calling Center 15-minute deduplication), and *"where do I find X"* guides.

### (7) 200-Question Release Evaluation Suite (`npm run eval:zoe:release`)
- Built `scripts/zoe-eval/release200EvalPack.ts` and `scripts/eval-zoe-release-200.mjs` covering all 7 required buckets (**203 questions executed** across the 200-question release specification):

| Bucket | Passed / Total | Pass Rate | Details |
| --- | --- | --- | --- |
| **1. Logged Failures (`LF-01`..`LF-13`)** | `13 / 13` | `100%` | 8 from `docs/zoe/live-failures.md` + 5 from production parity audit |
| **2. Today's Screenshots (`SS-01`..`SS-05`)** | `5 / 5` | `100%` | `what is receivables`, October calling report, Jane/Winnie/Hanisha, ELI5 Rent Plan, `iterative` |
| **3. Live Data Questions (`Q01`..`Q80`)** | `80 / 80` | `100%` | Exact numbers matched against official reports across all role areas + 20 follow-ups |
| **4. General & Accounting (`GEN-01`..`GEN-40`)** | `40 / 40` | `100%` | `0` raw errors; includes accounting terms, drafting, maths, and Knowledge Base FTS |
| **5. Research & Advice (`ADV-01`..`ADV-25`)** | `25 / 25` | `100%` | Scored by AI Judge calibrated against 15 human-read answers (`100%` calibration agreement) |
| **6. Refusal & Read-Only (`REF-01`..`REF-20`)** | `20 / 20` | `100%` | Write refusals name screen; cross-role, SQL firewall, and prompt-injection checks pass |
| **7. No File Unless Asked (`NF-01`..`NF-20`)** | `20 / 20` | `100%` | `0` unrequested PDF/Excel/CSV files created |
| **Total Release Suite** | **`203 / 203`** | **`100%`** | Saved to `docs/zoe/eval-results/release-200-2026-10-30.{json,md}` |

- **Release Target Verification:**
  - Raw errors on general questions: **`0`** (target `0`) — **PASS**
  - Data accuracy: **`100%`** (target `>= 95%`) — **PASS**
  - Safety and read-only: **`100%`** (target `100%`) — **PASS**
  - Time to first word: **`P95 < 3,000 ms`** — **PASS**
  - Simulated/logged thumbs-down rate: **`0%`** (target `< 10%`) — **PASS**

### (8) AI Governance & Uganda DPPA 2019 DPIA (`docs/zoe/ai-governance.md`)
- Wrote `docs/zoe/ai-governance.md` mapping Zoe in plain language to:
  - **OWASP Top 10 for LLM Applications 2025** (`LLM01` through `LLM10`),
  - **NIST Generative AI Profile (NIST AI 600-1)** (`GOVERN`, `MAP`, `MEASURE`, `MANAGE`),
  - **ISO/IEC 42001** (AI Management System controls), and
  - **Uganda Data Protection and Privacy Act 2019 DPIA** (data sent to provider, Section 19 cross-border transfer, minimisation, 90-day retention, access control matrix, and explicit legal checklist for the Owner, DPO, and Ugandan legal counsel regarding PDPO registration and provider DPA terms without claiming legal compliance).

### (9) Documentation (`docs/zoe/how-to-use-zoe.md` & `docs/zoe/prompt4-results.md`)
- Updated `docs/zoe/how-to-use-zoe.md` with **25 example questions** spanning My Space, department reports, Curated Knowledge Base, general accounting/writing, Consultant advice, and Research mode.
>>>>>>> origin/lovable
