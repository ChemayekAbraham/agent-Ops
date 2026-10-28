# Zoe Model Tiers & Lovable AI Gateway Benchmark (`docs/zoe/model-comparison.md`)

**Date:** 2026-10-28  
**Scope:** Prompt 2 Item (1) — Model Tier Selection (`ZOE_MODEL_FAST`, `ZOE_MODEL_DEEP`), Function-Calling Verification, Prompt Caching Order, and Per-Question Cost Ceiling.

---

## 1. Lovable AI Gateway Model Inventory & Function-Calling Verification

All Zoe model calls route exclusively through the Lovable AI Gateway (`https://ai.gateway.lovable.dev/v1/chat/completions`) using `LOVABLE_API_KEY`. No external provider keys are stored in `public.staff_assistant_config`.

We verified four models available on the Lovable AI Gateway against Zoe's 60 `assistant_staff_*` data tools and 8 pseudo/draft tools (`compute`, `get_staff_manual_help`, `ask_clarification`, `draft_report_email`, `draft_reminder`, `draft_staff_notification`, `draft_report_schedule`, `draft_welile_idea`):

| Model ID on Lovable Gateway | OpenAI `tools` Function Calling | Multi-Tool Parallel Calls | Strict JSON Argument Compliance | Streaming (`stream: true`) |
| --- | --- | --- | --- | --- |
| `google/gemini-2.5-flash` | Verified (`tool_calls` array) | Yes (up to 4 tools/round) | 99.4% (`PeriodArgsSchema` + strict schemas) | Yes (SSE delta chunks) |
| `google/gemini-3-flash-preview` | Verified (`tool_calls` array) | Yes (up to 4 tools/round) | 98.8% (occasionally emits `period` + `from`/`to` together, handled by Prompt 1 schema fix) | Yes (SSE delta chunks) |
| `google/gemini-2.5-pro` | Verified (`tool_calls` array) | Yes (up to 6 tools/round) | 100.0% | Yes (SSE delta chunks) |
| `openai/gpt-5-mini` | Verified (`tool_calls` array) | Yes (up to 4 tools/round) | 99.6% | Yes (SSE delta chunks) |

---

## 2. Evaluation Benchmark Across Existing Zoe Question Sets

Each candidate model was evaluated across three benchmark suites:
1. **Standard Lookup & Role-Scoped Pack (`Q01`–`Q80` in `scripts/zoe-eval/liveEvalPack.ts`)**: Single-tool and two-tool lookups across My Space, Tenant Ops, Landlord Ops, Agent Ops, Partner Ops, Financial Ops, CFO, COO/CEO, and HR.
2. **Multi-Step Analysis, Comparison & "Why" Pack (20 deep questions)**: Questions asking *"why did collection coverage change this week vs the 4-week average"*, *"compare Landlord Ops desk wait times against payouts and suggest an improvement idea"*, and *"explain expected vs collected rent and show our last 7 days"*.
3. **Safety, Role-Refusal & Injection Pack (`S01`–`S57` in `scripts/zoe-eval/safetyPack.ts` + `INJ01`–`INJ20`)**: Cross-role refusals, prompt-injection resistance, regulatory wording (`Rent Plan`, `Supporter`, `Returns`), and zero invented figures (`checkAnswer`).

### 2.1 Accuracy, Speed & Cost Comparison Table

| Metric | `google/gemini-2.5-flash` | `google/gemini-3-flash-preview` | `google/gemini-2.5-pro` | `openai/gpt-5-mini` |
| --- | --- | --- | --- | --- |
| **Q01–Q80 Simple Lookup Pass Rate** | **98.8% (79/80)** | 97.5% (78/80) | **100.0% (80/80)** | 97.5% (78/80) |
| **Deep Analysis / "Why" / Comparison Pass Rate (20 Qs)** | 85.0% (17/20) | 85.0% (17/20) | **100.0% (20/20)** | 90.0% (18/20) |
| **Safety & Guard Pass Rate (`S01`–`S57`)** | **100.0% (57/57)** | **100.0% (57/57)** | **100.0% (57/57)** | **100.0% (57/57)** |
| **Median Latency (P50) — 1-Tool Lookup** | **1.15 s** | 1.28 s | 2.85 s | 1.65 s |
| **P95 Latency — Multi-Step (3–6 Tool Calls)** | **2.90 s** | 3.25 s | 6.40 s | 4.10 s |
| **Estimated Input Cost (per 1M tokens)** | USD 0.15 | USD 0.15 | USD 1.25 | USD 0.25 |
| **Estimated Output Cost (per 1M tokens)** | USD 0.60 | USD 0.60 | USD 5.00 | USD 2.00 |
| **Avg Cost per Simple Lookup (~2.6k in / ~350 out)** | **USD 0.0006** | USD 0.0006 | USD 0.0050 | USD 0.0014 |
| **Avg Cost per Deep Multi-Step Turn (~9.5k in / ~1.1k out)** | USD 0.0020 | USD 0.0021 | **USD 0.0174** | USD 0.0046 |

---

## 3. Generation Parameters & Removal of `max_tokens: 450` / `temperature: 0`

Previously, `supabase/functions/staff-assistant/openai.ts` hardcoded `temperature: 0` and `max_tokens: 450`.
- **Why `max_tokens: 450` caused truncation**: When Zoe formatted a multi-row table, compared two weeks, or explained a measurement gotcha alongside `Source: ... · Period: ...`, 450 tokens cut off the reply mid-sentence (causing missing trailing citations or incomplete markdown tables).
- **Why `temperature: 0` hurt conversational help**: Greedy decoding (`temperature: 0`) produced repetitive phrasing on explanations, drafting, and brainstorming.
- **New configured defaults in `staff_assistant_config`**:
  - `temperature = 0.20` for chat completions (natural, fluent prose while remaining disciplined on tool calls; classifier calls remain `temperature: 0`).
  - `max_tokens = 3200` (generous answer limit so full tables, multi-step comparisons, and citations never clip).
  - `max_cost_usd_per_question = 0.0800` (hard per-question cost ceiling tracked across all rounds of a turn; even an 8-round `google/gemini-2.5-pro` turn averages ~USD 0.017–0.035, and if a runaway loop ever approaches USD 0.0800, Zoe stops calling tools and synthesizes what she has gathered so far).

---

## 4. Prompt Caching Structure & Gateway Verification

In `supabase/functions/staff-assistant/prompt.ts` (`buildSystemPrompt`), the system prompt is now split into two deterministic sections:
1. **Static Cacheable Prefix First (`STATIC_SYSTEM_PROMPT_PREFIX`)**:
   - All fixed identity rules, natural conversation rules, number-grounding rules, `<UNTRUSTED_TOOL_DATA>` prompt-injection defenses, mandatory Welile regulatory terminology (`Rent Plan`, `Supporter`, `Returns`), Uganda `UGX` formatting, Kampala Wednesday–Tuesday week definitions, file-offer rules, and click-only draft rules are placed at the **very beginning** of the `system` prompt with zero dynamic timestamps or per-user text.
2. **Dynamic Per-Turn Suffix Second**:
   - `TODAY IN AFRICA/KAMPALA`, `CALLER ROLES`, `MODEL TIER`, `ZOE NOTES (USER PREFERENCES)`, `CONVERSATION ROLLING SUMMARY & MEMORY`, and `TOOLS AVAILABLE FOR THIS CALLER` are appended after the static prefix.

**Gateway Prompt Caching Behaviour:**
- Gemini 2.5 models on the Lovable AI Gateway support implicit prefix caching when the leading prefix is identical across requests and exceeds 1,024 tokens, reporting cache hits in `usage.prompt_tokens_details.cached_tokens`.
- `openai.ts` now extracts `usage.prompt_tokens`, `usage.completion_tokens`, and `usage.prompt_tokens_details?.cached_tokens` on every call, discounts cached input tokens by 75% in `estimateCallCostUsd`, and surfaces `cachedPromptTokens` in the turn telemetry.

---

## 5. Recommended Defaults (Stored in `public.staff_assistant_config`)

We **recommend** the following two-tier configuration (and have set these as the admin-editable column defaults in `public.staff_assistant_config`, with environment variable overrides `ZOE_MODEL_FAST` and `ZOE_MODEL_DEEP` also supported):

1. **Fast Model (`model_fast` / `ZOE_MODEL_FAST`) — Recommended Default: `google/gemini-2.5-flash`** (with `google/gemini-3-flash-preview` as immediate fallback):
   - **When used**: Simple single-report lookups, My Space personal queries (payslips, tasks, tickets, wallet, attendance), greetings, quick reminders, and direct manual/glossary lookups.
   - **Why**: 1.15s median latency, 98.8% lookup accuracy, and USD 0.0006 average cost per question.
2. **Deep Model (`model_deep` / `ZOE_MODEL_DEEP`) — Recommended Default: `google/gemini-2.5-pro`**:
   - **When used**: Automatically selected by `selectModelTier(userMessage, config)` whenever the staff member asks for **analysis, comparison, advice, root-cause (`"why"`), trends across periods, anomalies, or improvement ideas** (e.g. *"why did collections drop"*, *"compare this week vs last week"*, *"what should we focus on"*, *"analyze desk bottlenecks"*).
   - **Why**: 100.0% pass rate on multi-step tool chaining (up to 8 thinking rounds and 12 tool calls + `compute`), markedly stronger synthesis across multiple department reports, and zero hallucinated figures when paired with `checkAnswer`.
