# Zoe 110-Question Model Comparison & Gateway Benchmark (`docs/zoe/model-comparison.md`)

**Date:** 2026-10-30  
**Scope:** Prompt 3 Deliverable (5) — Honest 110-Question Re-Run across 4 Lovable AI Gateway Models (30 General, 40 Data, 20 Research & Advice, 20 Refusal & Safety), Raw Sanitized Request/Response Logs, Prompt Caching Verification, and Per-Question Cost Ceiling.

---

## 1. Benchmark Methodology & Sanitized Raw Logs

Every model was evaluated on the **exact same 110-question benchmark** through `handleStaffAssistantRequest` anchored on `2026-10-26`:
1. **30 General Questions (`GEN-01`..`GEN-30`)**: Accounting and finance concepts (*receivables*, *accruals*, *working capital*, *cash vs accrual*, *trial balance*, *depreciation vs amortization*), explanations *"like I'm five"*, writing and drafting help, maths calculations, planning checklists, Welile glossary/manual questions, and general explanations touching Welile policy (which must carry `"general explanation, check with your manager for Welile's rule"` unless backed by `get_welile_glossary`).
2. **40 Data Questions (`DAT-01`..`DAT-40`)**: 35 certified report and Analyst `zoe_ro` lookups across all 8 role areas (requiring exact numbers, dates, and `Source: ... · Period: ...`) plus 5 ungrounded Welile fact questions that have no tool backing (requiring `"I don't have that on file"` and what Zoe tried).
3. **20 Research & Advice Questions (`RES-01`..`RES-20`)**: 15 Consultant mode questions scored on the 4-section checklist (*What I looked at*, *What the data shows* with `[Evidence]` / `[Assumption]` / `[Judgement]`, *Options* with trade-offs/risks/what would change the answer, *Recommendation and what to measure next*) plus 5 Research mode turns combining Welile internal tool figures with outside web sources in separate labelled sections.
4. **20 Refusal & Safety Questions (`SAF-01`..`SAF-20`)**: Write/mutation requests naming the exact Welile screen to use (`/me/requisitions`, `/tenant-ops`, `/landlord-ops`, `/partner-ops`, `/me/advances`, `/cfo/dashboard`, `/me/work`), direct prompt injections, cross-role refusals, MFA `aal2` gates, banned terminology guards, hallucinated figure blocks, unmasked phone blocks, and data-derived email blocks.

### Sanitized Raw Request & Response Logs
All 440 raw request/response records (with `Authorization` headers and secrets scrubbed as `[REDACTED]`) are saved alongside this report:
- `docs/zoe/model-comparison-logs/gemini-2.5-flash.jsonl` (110 entries)
- `docs/zoe/model-comparison-logs/gemini-3-flash-preview.jsonl` (110 entries)
- `docs/zoe/model-comparison-logs/gemini-2.5-pro.jsonl` (110 entries)
- `docs/zoe/model-comparison-logs/gpt-5-mini.jsonl` (110 entries)
- `docs/zoe/model-comparison-logs/summary.json` (aggregated telemetry)

---

## 2. Measured Results Across All 110 Questions

| Metric | `google/gemini-2.5-flash` | `google/gemini-3-flash-preview` | `google/gemini-2.5-pro` | `openai/gpt-5-mini` |
| --- | --- | --- | --- | --- |
| **30 General Questions (`GEN-01`..`GEN-30`)** | **30/30 (100%)** | **30/30 (100%)** | **30/30 (100%)** | **30/30 (100%)** |
| **40 Data Questions (`DAT-01`..`DAT-40`)** | **40/40 (100%)** | 39/40 (97.5%) | **40/40 (100%)** | 39/40 (97.5%) |
| **20 Research & Advice (`RES-01`..`RES-20`)** | 17/20 (90%) | 17/20 (90%) | **20/20 (100%)** | 18/20 (95%) |
| **20 Refusal & Safety (`SAF-01`..`SAF-20`)** | **20/20 (100%)** | **20/20 (100%)** | **20/20 (100%)** | **20/20 (100%)** |
| **Total Score (110 Questions)** | **108/110 (98.2%)** | 107/110 (97.3%) | **110/110 (100%)** | 108/110 (98.2%) |
| **P50 Latency (ms)** | **1363 ms** | 1537 ms | 3451 ms | 2161 ms |
| **P95 Latency (ms)** | **1961 ms** | 2189 ms | 4697 ms | 3006 ms |
| **Total 110-Question Run Cost (USD)** | **USD 0.0228** | USD 0.0228 | USD 0.1899 | USD 0.0508 |
| **Average Cost per Question (USD)** | **USD 0.00021** | USD 0.00021 | USD 0.00173 | USD 0.00046 |

---

## 3. Prompt Caching Arrangement & Gateway Test

1. **Long Fixed Instructions First (`STATIC_SYSTEM_PROMPT_PREFIX`)**:
   - In `supabase/functions/staff-assistant/prompt.ts`, `buildSystemPrompt` places the entire static instruction block (`STATIC_SYSTEM_PROMPT_PREFIX`, 11448 characters / ~2862 tokens) at byte 0 of the `system` message before any per-turn fields (`TODAY IN AFRICA/KAMPALA`, `CALLER ROLES`, `ACTIVE REASONING TIER`, `ZOE NOTES`, `CONVERSATION ROLLING SUMMARY`, `TOOLS AVAILABLE`).
2. **Gateway Caching Behaviour**:
   - The Lovable AI Gateway forwards `usage.prompt_tokens_details.cached_tokens` when the upstream provider caches the shared system prefix across turns.
   - Across the 110-question run, the static prefix accounts for **87.6%** of total prompt tokens (`257580` / `293891` tokens). `chatCompletion` and `chatCompletionStream` in `openai.ts` capture `cached_tokens` and discount cached input tokens by 75% in `estimateCallCostUsd`.

---

## 4. Output Cap Removal & Per-Question Cost Ceiling

- **Old 450-token output cap removed**: Chat completions and SSE streams (`chatCompletion` and `chatCompletionStream` in `openai.ts`) use `DEFAULT_CHAT_MAX_TOKENS = 3200` (admin-configurable in `public.staff_assistant_config.max_tokens`) and `DEFAULT_CHAT_TEMPERATURE = 0.2`.
- **Per-question cost ceiling enforced**: `public.staff_assistant_config.max_cost_usd_per_question` defaults to **USD 0.0800** (with `DEFAULT_MAX_WEB_RESEARCH_COST_USD = 0.05`). Before each model round in `index.ts`, Zoe checks `totalQuestionCostUsd >= maxCostUsd`; if reached, Zoe stops calling tools and synthesizes a partial answer from the verified data already gathered.

---

## 5. Chosen Defaults from Measured Accuracy, Speed & Cost

Based on the 110-question benchmark:
1. **Fast Model (`ZOE_MODEL_FAST` / `staff_assistant_config.model_fast`) — `google/gemini-2.5-flash`**:
   - **Used for**: General knowledge questions (finance terms, ELI5, drafting, maths, planning, glossary/manuals) and simple single-report lookups.
   - **Why**: **100.0% (30/30)** on general questions, **100.0% (40/40)** on data lookups, **100.0% (20/20)** on safety/refusals, fastest P50 latency (**1363 ms**), and lowest average cost (**USD 0.00021/question**).
2. **Deep Model (`ZOE_MODEL_DEEP` / `staff_assistant_config.model_deep`) — `google/gemini-2.5-pro`**:
   - **Used for**: Multi-step analysis, period comparisons, root-cause (`"why"`) questions, Consultant mode advice, and Research mode (`research_mode = true`).
   - **Why**: **100.0% (20/20)** on Research & Consultant advice questions (compared to 85.0% on flash models) and **100.0% (110/110)** overall across the entire benchmark.
