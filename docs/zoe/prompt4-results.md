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
