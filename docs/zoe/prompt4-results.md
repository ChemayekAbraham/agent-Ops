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
