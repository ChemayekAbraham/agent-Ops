# Zoe Prompt 4 Plan — Predictive, Learning, Knowledge & Proper Measurement

**Date:** 2026-10-30  
**Pre-Check:** `node scripts/guard-zoe-parity.mjs --check-live` → **PASS** (`15 tables, 117 columns, 19 views, and 111 RPCs verified across 42 code files`). Prompts 1 to 3 are live.

---

## 1. Database-First Migration Plan (Prepared — Awaiting Owner Confirmation to Apply)

- **Migration file:** [`supabase/migrations/20261030140000_staff_assistant_prompt4_learning_kb_and_starters.sql`](file:///Users/Timothy/Desktop/WELILE/welilereceipts-com-98bba33b/supabase/migrations/20261030140000_staff_assistant_prompt4_learning_kb_and_starters.sql)
- **Verification SQL:** [`supabase/tests/zoe_prompt4_verification.sql`](file:///Users/Timothy/Desktop/WELILE/welilereceipts-com-98bba33b/supabase/tests/zoe_prompt4_verification.sql)
- **Rollback SQL:** [`supabase/rollbacks/20261030140000_staff_assistant_prompt4_learning_kb_and_starters.rollback.sql`](file:///Users/Timothy/Desktop/WELILE/welilereceipts-com-98bba33b/supabase/rollbacks/20261030140000_staff_assistant_prompt4_learning_kb_and_starters.rollback.sql)

### Database Objects Prepared in `20261030140000`:
1. **`public.staff_assistant_preferences` additions:**
   - `memory_enabled boolean NOT NULL DEFAULT true`
   - `dismissed_memory_prompts text[] NOT NULL DEFAULT '{}'`
2. **`public.staff_assistant_learning_log` (table + RLS + `mfa_required_for_staff` + grants):**
   - Stores `topic` (fixed 13-topic taxonomy), `tool_used`, `outcome`, `latency_ms`, `cost_usd`, `model_tier`, `feedback_rating`, `feedback_theme`, and `created_at` — **with no question text column** so a second copy of staff text is never stored.
3. **`public.staff_assistant_eval_candidates` (table + RLS + `mfa_required_for_staff` + grants):**
   - Stores PII-scrubbed questions promoted from the review queue via **"Add to tests"**.
4. **`public.staff_assistant_knowledge_base` (table + GIN `search_tsv` full-text index + RLS + `mfa_required_for_staff` + grants + 10 reviewed seed entries):**
   - Seeded from `SYSTEM_CONTEXT.md`, `.agents/skills/welile-chart-of-accounts/SKILL.md`, `supabase/AGENTS.md`, and staff manuals across 5 categories (`glossary`, `product_policy`, `process_explanation`, `where_to_find`, `measurement_gotcha`).
5. **Read-Only Zoe Tool RPCs (`STABLE SECURITY DEFINER`, caller-checked, `authenticated` only):**
   - `public.assistant_staff_personalised_starters()` — returns up to 3 starter prompts for the signed-in person from their own last 30 days of topics (never other people's text), their role, and what their role's tools can answer.
   - `public.assistant_staff_search_knowledge_base(p_query, p_category, p_limit)` — searches `staff_assistant_knowledge_base` with Postgres full-text search (`websearch_to_tsquery` + `ts_rank_cd`) before any web search, returning structured citations.
   - `public.assistant_staff_morning_brief_what_changed()` — returns up to 3 role-scoped "What changed" lines comparing today with the 4-week average, each with its source and screen link (`in_app_only: true`).
6. **Screen / Reviewer RPCs (never exposed as Zoe tools):**
   - `public.staff_assistant_update_note(p_note_id, p_note_text)` — lets staff edit an existing Zoe note from the `"..."` menu while blocking business figures, phones, emails, NINs, UUIDs, and banned terms.
   - `public.staff_assistant_set_memory_prefs(p_memory_enabled, p_dismiss_preference_key)` & `public.staff_assistant_get_memory_prefs()`.
   - `public.staff_assistant_upsert_knowledge_entry(...)` — lets managers edit knowledge base entries through a screen, never through Zoe.
   - `public.staff_assistant_promote_to_eval_set(...)` & `public.staff_assistant_weekly_manager_learning_view(p_days)`.

---

## 2. Five-Commit Delivery Plan (After Owner Confirms Database Migration)

1. **Commit 1 of 5:** Database migration (`20261030140000`), verification SQL (`zoe_prompt4_verification.sql`), rollback SQL, parity manifest update, and `guard-staff-assistant.mjs` table registration.
2. **Commit 2 of 5:** Edge function & core logic for Items (1)–(6):
   - Personalised starters (`personalised_starters` action + `assistant_staff_personalised_starters`).
   - Grounded next-question suggestions (`buildFollowUpSuggestions` inspecting answer payload + verifying tool/Analyst capability).
   - Memory that learns (`detectRepeatedUserPreference` offering `"Remember this?"` once with Save / No thanks, `memory_off` switch, `temporary_chat` mode reading/writing zero memory, note editing).
   - "What changed" Morning Brief (2–3 lines comparing today vs 4-week average, source, mute switch, screen link, capped at 3 items, no email/SMS).
   - Learning loop topic classifier & logger (`recordLearningEvent` without storing text) + Knowledge Base FTS tool (`search_knowledge_base` checked before web search).
3. **Commit 3 of 5:** Frontend UI for Items (1)–(6):
   - Personalised starters in `ZoeChatSurface.tsx` & `useZoeAssistant.ts`.
   - `"Remember this?"` one-time banner (Save / No thanks), editable notes in `"..."` menu, **Memory off** switch, and **Temporary chat** toggle.
   - Updated `ZoeMorningBriefCard.tsx` (today vs 4-week average, mute switch, screen link, max 3 items).
   - Weekly manager learning view & review queue with **"Add to tests"** button + Manager Knowledge Base editor screen in `ZoeConversationsPanel.tsx` / `ZoeChatSurface.tsx`.
4. **Commit 4 of 5:** Item (7) — 200-question Release Evaluation Suite (`scripts/eval-zoe-release-200.mjs`):
   - 13 logged failures + 5 screenshot failures + 80 live data questions + 40 general/accounting questions + 25 research/advice questions + 20 refusal/read-only checks + 17/20 "no file unless asked" checks = 200 questions.
   - Calibrated AI judge + 15 human-calibrated sample audit, exact number verification, groundedness, time-to-first-word, cost per question, dated raw results under `docs/zoe/eval-results/`.
5. **Commit 5 of 5:** Items (8) & (9) + Automated Tests:
   - `docs/zoe/ai-governance.md` (OWASP LLM Top 10 2025, NIST AI 600-1, ISO/IEC 42001, and Uganda Data Protection and Privacy Act 2019 DPIA including Section 19 cross-border transfer, 90-day retention, and lawyer checklist).
   - `docs/zoe/prompt4-results.md` and `docs/zoe/how-to-use-zoe.md` updated with 25 example questions (including general and research questions).
   - Full Vitest + guard suite verification.
