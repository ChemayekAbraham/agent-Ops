# Prompt 2 Results — A Stronger, More Natural Brain

**Generated:** 28 October 2026 (Africa/Kampala)  
**Scope:** Prompt 2 from `docs/ZOE_BRILLIANT_ASSISTANT_PROPOSAL.md`

---

## 1. Model Tiers & Prefix Caching (`openai.ts`, `staff_assistant_config`, `docs/zoe/model-comparison.md`)

- **Configured Model Pair**:
  - Replaced the fixed `google/gemini-3-flash-preview` in `supabase/functions/staff-assistant/openai.ts` with a configured pair stored in `public.staff_assistant_config` (`model_fast` / `ZOE_MODEL_FAST`, `model_deep` / `ZOE_MODEL_DEEP`).
  - Removed `max_tokens: 450` and `temperature: 0` for chat, replacing them with `temperature = 0.20`, `max_tokens = 3200`, and a per-question cost ceiling (`max_cost_usd_per_question = 0.0800`).
- **Gateway Model Comparison (`docs/zoe/model-comparison.md`)**:
  - Compared `google/gemini-2.5-flash`, `google/gemini-3-flash-preview`, `google/gemini-2.5-pro`, and `openai/gpt-5-mini` across the 80-question accuracy pack, 20 deep analysis/`"why"` questions, and 57-item safety pack.
  - Recommended defaults configured in `staff_assistant_config`:
    - `ZOE_MODEL_FAST`: `google/gemini-2.5-flash` (simple lookups, 4 rounds / 6 tool calls).
    - `ZOE_MODEL_DEEP`: `google/gemini-2.5-pro` (analysis, comparisons, advice, and `"why"` questions, 8 rounds / 12 tool calls).
- **Prompt Prefix Caching**:
  - Placed `STATIC_SYSTEM_PROMPT_PREFIX` at the very start of `buildSystemPrompt` in `supabase/functions/staff-assistant/prompt.ts` and dynamic session context (`todayKampala`, `callerRoles`, `modelTier`, `zoeNotesBlock`, `rollingSummaryBlock`, `conversationMemoryBlock`, `toolDescriptions`) second.
  - Added `parseGatewayUsage` in `openai.ts` to capture `cached_tokens` from the Lovable AI Gateway.

---

## 2. Natural Conversation (`prompt.ts`, `manualHelp.ts`, `messages.ts`, `index.ts`)

- **Removed Canned `UNMATCHED` & `OUT_OF_SCOPE` Scripts from Normal Conversation**:
  - Zoe answers greetings, explanations, drafting, brainstorming, and general work help directly without forcing a canned refusal.
- **Strict Grounding Preserved**:
  - Every Welile business figure, count, percentage, phone number, email address, or date still requires a read-only tool call and must pass `checkAnswer`.
  - If Zoe cannot find data, she states what she checked and suggests the closest alternative screen or person.
  - Harmful/illegal requests and data-mutation requests are refused plainly while naming the screen to use (`/me/requisitions`, `/tenant-ops`, `/landlord-ops`, `/cfo/dashboard`).

---

## 3. Multi-Step Loop (`index.ts`, `memory.ts`, `openai.ts`)

- **Raised Deep Limits**:
  - Raised deep reasoning limits to **8 thinking rounds** (`MAX_DEEP_MODEL_ROUNDS = 8`) and **12 tool calls** (`MAX_DEEP_TOOL_CALLS = 12`) per question.
- **Per-Step Safety Locks**:
  - Every tool step enforces `canUseTool` (role check), `requireStaffAal2` (MFA AAL2 gate on sensitive tools), `prepareToolOutputForModel` (masking/dedup/prompt-injection wrapping), and `checkAnswer` (deterministic number/PII/terminology guard).
- **Graceful Partial Summary on Step or Cost Limit**:
  - When a question hits its round, tool, or cost limit after gathering partial tool results, `synthesizePartialStepLimitReply` returns `"I reached my limit, here is what I have so far:"` grounded strictly in the tool outputs collected so far.

---

## 4. Streaming & Live Status (`index.ts`, `useZoeAssistant.ts`, `ZoeChatSurface.tsx`)

- **Live Status Lines & Token Streaming**:
  - Streams answers token by token with live tool status lines (`"Checking collections…"`, `"Comparing weeks…"`, `"Reading the Welile glossary…"`, etc.) and an `AbortController`-backed **Stop** button (`data-testid="zoe-stop-button"`).

---

## 5. Conversation Memory & Zoe Notes (`memory.ts`, `guards.ts`, `store.ts`, `ZoeChatSurface.tsx`)

- **Whole-Conversation Memory (`rolling_summary`)**:
  - Added `rolling_summary` to `public.staff_assistant_conversations` (`buildRollingConversationSummary`) so older turns are summarised and retained across long conversations alongside the latest 20 verbatim messages.
- **Zoe Notes (`public.staff_assistant_notes`)**:
  - Up to 20 short personal preferences per user (`MAX_ZOE_NOTES_PER_USER = 20`), user-visible and deletable in the **Zoe notes** drawer (`data-testid="zoe-notes-drawer"`).
  - Enforced `validateZoeNoteText` in `guards.ts` so notes never store UGX figures, numbers `>= 100`, percentages, phone numbers, email addresses, UUIDs, NINs, or banned terminology.

---

## 6. Welile Glossary & Measurement Gotchas (`get_welile_glossary`, `public.staff_assistant_glossary`)

- **Read-Only Tool (`get_welile_glossary` -> `public.assistant_staff_get_glossary`)**:
  - Added `STABLE SECURITY DEFINER` RPC `public.assistant_staff_get_glossary(p_search, p_category)` seeded with 10 Welile definitions and measurement gotchas (expected vs collected repayments, treasury cash vs wallet liability, active Rent Plan & repayment clock, field agent vs sub-agent, wallet buckets, mandatory regulatory terminology, landlord verification & payout lock, calling center deduplication, etc.).
- **Manager Glossary Screen**:
  - Added the **Glossary** drawer (`data-testid="zoe-glossary-drawer"`) and manager-only editor (`data-testid="zoe-glossary-manager-form"` calling `public.zoe_glossary_upsert_entry`) so managers can edit terms through the screen — never through Zoe chat.

---

## 7. Guard & Test Verification

- `npm run guard:all`: **PASS** (`guard:staff-assistant` verified 16 function sources, 60 tool RPCs, 61 `assistant_staff_*` SQL functions, and 14 self-tests).
- `npx vitest run src/lib/zoe/ src/components/zoe/`: **PASS** (all unit, UI, and real-handler tests passing).
