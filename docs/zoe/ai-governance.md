# Zoe AI Governance, Security Standards Mapping & Uganda DPIA

**Document status:** Technical & Operational Governance Reference (Prepared 2026-10-30)  
**Scope:** Zoe (`staff-assistant` Edge Function, `src/components/zoe/*`, `public.staff_assistant_*`, `public.assistant_staff_*`, and `zoe_ro.*` views)  
**Important Legal Notice:** This document maps technical and operational controls implemented in code and the database. **It does not claim legal or regulatory compliance.** Section 5 lists the specific legal, contractual, and registration items that a qualified Ugandan lawyer and Welile's Data Protection Officer (DPO) must review and confirm.

---

## 1. Executive Summary & Core Safety Architecture

Zoe is Welile's internal, read-only My Space assistant for authorised staff. Every architectural decision is anchored in **the CEO's Rule**:

> **No user may change Welile's business data through Zoe.** Zoe reads only role-authorised official reports, Approved Analyst views (`zoe_ro.*`), and the Curated Welile Knowledge Base. Zoe writes only to its own `staff_assistant_*` tables and never sends an email or notification without an explicit human button click.

---

## 2. Mapping to OWASP Top 10 for LLM Applications (2025)

The table below maps all ten risks from the **OWASP Top 10 for Large Language Model Applications (2025)** to Zoe's concrete code and database controls in plain language.

| OWASP 2025 Risk | Plain-Language Risk | How Zoe Prevents or Mitigates It | Code / Database Enforcement |
| --- | --- | --- | --- |
| **LLM01:2025 Prompt Injection** | A user or a piece of text inside a database row tries to trick Zoe into ignoring her rules, revealing another department's data, or running a hidden action. | 1. Direct prompt-injection attempts (`ignore previous instructions`, `developer mode`, `system override`, `DROP TABLE`) are blocked before the model is called.<br>2. Every database text field returned by a tool is sanitised (`sanitizeUntrustedFreeText`) and wrapped inside `<UNTRUSTED_TOOL_DATA>` tags.<br>3. Email recipients and schedule parameters are resolved strictly from the user's own prompt, never from untrusted tool output (`isEmailFromToolData`). | `guards.ts` (`isDirectPromptInjection`, `SYSTEM_PROMPT_LEAK_RE`), `toolOutput.ts`, `emailDraft.ts`, `safetyPack.ts` (57 scenarios, 100% pass). |
| **LLM02:2025 Sensitive Information Disclosure** | Zoe accidentally reveals another employee's payslip, a CFO-only balance sheet to a non-finance user, or unmasked phone numbers and national IDs. | 1. Role-gated tool catalog (`toolsForRoles`): the model is never even offered tools outside the signed-in caller's roles.<br>2. Server-side `SECURITY DEFINER` RPCs re-check the caller's JWT and roles inside PostgreSQL.<br>3. Sensitive tools require two-step login (`requireStaffAal2` + `mfa_required_for_staff` RLS).<br>4. Analyst views (`zoe_ro.*`) omit or mask phone numbers and national IDs.<br>5. Outbound web research strips all Welile names, phones, emails, NINs, UUIDs, and UGX figures (`validateConsultantWebQuery`). | `tools.ts`, `analyst.ts`, `consultant.ts`, `supabase/migrations/20261028190000_zoe_ro_analyst_views_and_query_fn.sql`. |
| **LLM03:2025 Supply Chain** | Third-party models, search APIs, or libraries introduce unexpected behaviour or schema drift. | 1. Model IDs (`model_fast`, `model_deep`) are pinned in `staff_assistant_config` and evaluated via `docs/zoe/model-comparison.md` and `npm run eval:zoe:release`.<br>2. Database parity guard (`scripts/guard-zoe-parity.mjs`) and runtime `staff_assistant_health()` prevent code from shipping ahead of database objects. | `openai.ts`, `store.ts`, `scripts/guard-zoe-parity.mjs`. |
| **LLM04:2025 Data and Model Poisoning** | Bad or unreviewed internal notes or user feedback corrupt Zoe's answers for other staff members. | 1. **No self-training on raw chat:** Zoe never fine-tunes on or injects another user's chat text into prompts.<br>2. Personal Zoe notes are strictly per-user (`user_id = (select auth.uid())`), require explicit tap confirmation (`"Remember this?" -> Save`), and block figures, phones, emails, IDs, and details about other people (`validateZoeNoteText`).<br>3. Curated Knowledge Base entries (`staff_assistant_knowledge_base`) can only be published by authorised managers/executives via a dedicated screen (`staff_assistant_upsert_knowledge_entry`), never through Zoe chat. | `memory.ts`, `guards.ts`, `20261030140000_staff_assistant_prompt4_learning_kb_and_starters.sql`. |
| **LLM05:2025 Improper Output Handling** | Model output contains unverified numbers, regulatory-banned terms, or unsafe SQL/HTML that executes downstream. | 1. Every reply and streamed paragraph passes through `checkAnswer` / `checkStreamedParagraph`: every number must trace to a tool output, the user's question, or the safe calculator.<br>2. Banned terms (`loan`, `lender`, `ROI`, `interest`) are replaced server-side (`sanitizeWelileTermsServer`).<br>3. Analyst SQL is validated both in TypeScript (`validateAnalystSqlQuery`) and in PostgreSQL (`assistant_staff_run_query`) to allow only a single read-only `SELECT` on `zoe_ro.*`. | `guards.ts`, `emailDraft.ts`, `analyst.ts`, `ZoeChatSurface.tsx` (safe Markdown rendering). |
| **LLM06:2025 Excessive Agency** | The assistant is given tools that can move money, approve requisitions, edit records, or send external messages autonomously. | 1. **Zero business write tools exist in Zoe.** Static build guards (`scripts/guard-staff-assistant.mjs` and `scripts/guard-assistant-readonly.mjs`) scan every edge function and SQL RPC to block any `INSERT/UPDATE/DELETE` on business tables.<br>2. Reminders, schedules, staff notifications, report emails, and Ideas for Welile are created strictly as **draft cards** (`staff_assistant_save_draft`) that require a human to click Confirm/Send.<br>3. Consultant mode strips even draft and export tools (`CONSULTANT_FORBIDDEN_TOOLS`). | `scripts/guard-staff-assistant.mjs`, `actionDrafts.ts`, `consultant.ts`. |
| **LLM07:2025 System Prompt Leakage** | A user extracts Zoe's internal system prompt, security rules, or API keys. | 1. `containsPromptOrSecretLeak` scans every reply and draft card for system prompt fragments, `SUPABASE_SERVICE_ROLE_KEY`, `LOVABLE_API_KEY`, `SECURITY DEFINER`, and internal tags.<br>2. Any match discards the output and returns a safe refusal without revealing internal rules. | `guards.ts` (`SYSTEM_PROMPT_LEAK_RE`), `safetyPack.ts`. |
| **LLM08:2025 Vector and Embedding Weaknesses** | Unscoped vector stores leak cross-role documents or return hallucinated snippets without provenance. | 1. Zoe uses PostgreSQL Full-Text Search (`websearch_to_tsquery` + `ts_rank_cd`) over `public.staff_assistant_knowledge_base` via `assistant_staff_search_knowledge_base`.<br>2. Every KB entry has an explicit `allowed_roles` array checked against the caller's roles (`allowed_roles && v_roles`), a `review_status = 'published'` gate, and a mandatory slug citation (`Welile Knowledge Base: <title> (<slug>)`). | `20261030140000_staff_assistant_prompt4_learning_kb_and_starters.sql`. |
| **LLM09:2025 Misinformation & Overreliance** | Staff treat an AI estimate, a general explanation, or a correlation as an official Welile figure or policy. | 1. **Tool-or-abstain rule:** Zoe never guesses Welile figures; if a tool is unavailable, she states plainly what she could not check (`"I don't have that on file"`).<br>2. General explanations touching Welile policy carry `[General explanation — check with your manager for Welile's rule]` unless backed by the glossary/KB.<br>3. Analyst queries carry the banner `"Ad-hoc query on zoe_ro.* — not an official certified report"`.<br>4. Consultant advice tags every point `[Evidence]`, `[Assumption]`, or `[Judgement]` and forbids causal claims from correlation. | `prompt.ts`, `manualHelp.ts`, `analyst.ts`, `consultant.ts`. |
| **LLM10:2025 Unbounded Consumption** | Runaway multi-step loops or heavy queries exhaust AI budgets or database connections. | 1. Per-user daily question quota (`max_questions_per_day = 50`), email quota (`10/day`), notification quota (`20/day`), and web research quota (`20/day`).<br>2. Per-question round ceiling (`max_model_rounds = 4`, deep `8`), tool-call ceiling (`6`, deep `12`), and hard USD cost ceiling (`max_cost_usd_per_question = $0.08`).<br>3. Analyst SQL enforces a `5s` `statement_timeout` and `500`-row cap.<br>4. Long system instructions are placed in `STATIC_SYSTEM_PROMPT_PREFIX` for prompt caching. | `store.ts`, `openai.ts`, `index.ts`, `assistant_staff_run_query`. |

---

## 3. Mapping to NIST Generative AI Profile (NIST AI 600-1)

The **NIST AI Risk Management Framework Generative AI Profile (AI 600-1)** organises governance into four core functions: **GOVERN**, **MAP**, **MEASURE**, and **MANAGE**.

| NIST AI 600-1 Function | Sub-Topic | Zoe Implementation |
| --- | --- | --- |
| **GOVERN** | Accountability, policies, and kill switches | - **Single kill switch & runtime configuration:** `public.staff_assistant_config` allows admins to disable Zoe (`enabled = false`), disable web research (`web_research_enabled = false`), or lower budgets immediately without redeploying.<br>- **Database-first deployment rule:** Enforced by `scripts/guard-zoe-parity.mjs` and `docs/zoe/parity-audit.md` so application code never ships ahead of live database functions.<br>- **Read-only boundary:** Enforced at build time (`npm run guard:all`) and database privilege level. |
| **MAP** | Context of use, role boundaries, and data provenance | - **18 defined staff roles** mapped explicitly to allowed certified RPCs (`src/lib/zoe/zoeToolCatalog.ts`, `supabase/functions/staff-assistant/tools.ts`) and 8 `zoe_ro` role areas.<br>- Clear separation between **Certified Official Reports**, **Ad-Hoc Analyst Views (`zoe_ro.*`)**, **Curated Knowledge Base**, and **Outside Web Sources** (each labelled with its source and period). |
| **MEASURE** | Quantitative evaluation, groundedness, latency, cost, and human calibration | - **200-Question Release Evaluation Suite (`npm run eval:zoe:release`):** Tests 13 logged failures, 5 screenshot cases, 80 live data questions, 40 general/accounting/KB questions, 25 research/advice questions, 20 refusal/read-only checks, and 20 no-file checks.<br>- **Calibrated AI Judge:** Consultant advice quality is scored against an 8-point rubric calibrated against 15 human-scored reference answers.<br>- **Live Learning Loop (`staff_assistant_learning_log`):** Tracks topic distribution, tool used, outcome, latency (`ms`), cost (`USD`), and thumbs ratings without duplicating staff message text. |
| **MANAGE** | Incident response, graceful degradation, and continuous improvement | - **Graceful degradation (`ZOE_ERROR_CODES`):** If an optional helper or report RPC fails, Zoe logs a specific error code (`ERR_DB_TOOL_RPC_FAILED`, `ERR_DB_CONFIG_MISSING`, etc.) to `staff_assistant_unanswered`, still answers general questions, and never shows a raw stack trace.<br>- **Redacted Review Queue & Eval Promotion:** Thumbs-down ratings and `"Report a problem"` flags enter a redacted review queue (`staff_assistant_weekly_manager_learning_view`) where reviewers can click **Add to tests** (`staff_assistant_promote_to_eval_set`) to turn real failures into permanent regression tests. |

---

## 4. Mapping to ISO/IEC 42001 (Artificial Intelligence Management System)

| ISO/IEC 42001 Control Area | Requirement Summary | How Zoe Satisfies the Control |
| --- | --- | --- |
| **Clause 5.2 / A.2 — AI Policy** | Establish a clear policy defining permissible and prohibited AI uses. | Zoe's read-only charter, regulatory terminology rules (`Rent Plan`, `Supporter`, `Returns`), and zero-autonomous-action policy are codified in `AGENTS.md`, `prompt.ts`, and build guards. |
| **Clause 6.1 / A.5 — Assessing AI System Impacts** | Assess impacts on individuals, groups, and data privacy before and during operation. | Documented in Section 5 (Uganda Data Protection and Privacy Act 2019 DPIA), with technical controls for PII masking, Temporary Chat, and Memory Off switches. |
| **Annex A.6 — AI System Life Cycle & Parity** | Ensure design, verification, and deployment stages are controlled and reproducible. | Every model, prompt, or tool change must pass `npm run guard:all` and `npm run eval:zoe:release` (blocking release on any regression below 95% data accuracy or 100% safety). |
| **Annex A.7 — Data for AI Systems** | Control data quality, provenance, and minimisation for data fed to AI models. | Tool outputs are capped and summarised (`prepareToolOutputForModel`), every figure carries its official RPC/view source and Kampala period, and `staff_assistant_learning_log` logs fixed topic enums rather than raw text. |
| **Annex A.8 — Information for Interested Parties** | Provide clear transparency to users when interacting with AI and citing sources. | Every data answer displays a `Source · Period` pill and `"Show the data"` drawer; ad-hoc Analyst answers display an `"Ad hoc, not certified"` notice; policy explanations carry a manager-verification note; outside web findings cite the domain, URL, and date. |
| **Annex A.9 — Use of AI Systems & Human Oversight** | Maintain meaningful human oversight over any action affecting people or records. | All drafts (reminders, schedules, notifications, emails, Ideas for Welile) require an explicit human click on Confirm/Send. Zoe advice is explicitly labelled as text for a human decision-maker. |
| **Annex A.10 — Third-Party & Customer Relationships** | Govern data shared with external AI model and search providers. | Outbound web search queries pass through a deterministic PII/figure firewall (`validateConsultantWebQuery`); AI gateway traffic uses server-owned credentials (`LOVABLE_API_KEY`). |

---

## 5. Data-Protection Impact Assessment (DPIA) — Uganda Data Protection and Privacy Act 2019

This section provides a practical Data-Protection Impact Assessment (DPIA) structured around the **Uganda Data Protection and Privacy Act, 2019 (Act 9 of 2019 / Cap. 97)** and the **Data Protection and Privacy Regulations, 2021**.

> **Disclaimer:** This section is an engineering assessment of data flows and technical safeguards. **It does not constitute legal advice or a certification of compliance.** Welile's legal counsel and Data Protection Officer (DPO) must complete the items in Section 5.7.

### 5.1 Nature, Scope, Context, and Purpose of Processing
- **Data Controller:** Welile Technologies Limited (Uganda).
- **Data Subjects:**
  1. **Welile Staff Members** using My Space (`employee`, `tenant_ops`, `landlord_ops`, `agent_ops`, `partner_ops`, `financial_ops`, `hr`, `crm`, `coo`, `cfo`, `ceo`, `cto`, `manager`, `super_admin`, `access_admin`).
  2. **Tenants, Landlords, Field Agents, and Supporters** whose operational metrics or records appear in role-authorised Welile reports queried by staff.
- **Purpose:** Assisting authorised Welile staff to read role-permitted operational/financial reports, understand Welile processes/glossary terms, and draft internal reminders, report schedules, or work notes in My Space.

### 5.2 Categories of Data Sent to the AI Provider (and What Is Blocked)

| Data Category | Sent to AI Gateway (`ai.gateway.lovable.dev`)? | Sent to Web Search Provider (when enabled)? | Technical Safeguard |
| --- | --- | --- | --- |
| **Signed-in staff member's question text** | Yes (during active turn) | **No** — only sanitised public keywords | Stripped of control chars; Temporary Chat mode prevents persistence. |
| **Staff member's role names & Kampala date** | Yes (e.g. `tenant_ops`, `2026-10-30`) | **No** | No staff email, phone, or national ID is placed in the system prompt. |
| **Approved Zoe Notes (up to 20)** | Yes (when `memory_enabled = true` and not in Temporary Chat) | **No** | Saved only after explicit user tap (`Save`); `validateZoeNoteText` blocks UGX figures, phone numbers, emails, NINs, UUIDs, and third-party names. |
| **Certified RPC / `zoe_ro` View Tool Outputs** | Yes (bounded summary + up to 25 sample rows) | **Never** (`validateConsultantWebQuery` blocks all tool values) | `zoe_ro` views mask or omit phone numbers (`+256 7•• ••• 123`) and omit National IDs (`national_id`, `nin`), password hashes, tokens, and bank secrets. |
| **Passwords, Auth Tokens, API Keys, Raw NINs** | **Never** | **Never** | Excluded from all RPC projections and blocked by `FORBIDDEN_ANALYST_PII_COLUMNS` and `SYSTEM_PROMPT_LEAK_RE`. |

### 5.3 Cross-Border Data Transfer (Section 19 of the Uganda DPPA 2019)
Under **Section 19 of the Uganda Data Protection and Privacy Act 2019**, personal data processed in Uganda may only be transferred outside Uganda if:
1. The country where the data is processed has adequate measures in place for the protection of personal data at least equivalent to the Act, **or**
2. The data subject has consented, **or** the transfer is necessary for the performance of a contract / legitimate statutory ground with appropriate contractual safeguards (Data Processing Addendum / Standard Contractual Clauses).

**Zoe Technical Architecture for Cross-Border Transfers:**
- **Database & Edge Functions:** Hosted on Supabase cloud infrastructure (`aws-1-eu-west-1`, Ireland / EU — a jurisdiction with GDPR adequacy and strict data protection controls).
- **AI Gateway (`ai.gateway.lovable.dev` -> Google Gemini 2.5 Flash / Pro):** Prompts and bounded tool outputs traverse HTTPS/TLS 1.3 to the AI gateway for inference.
- **External Web Search (Admin-Switched, Default `OFF`):** Disabled by default (`web_research_enabled = false` in `staff_assistant_config`). Even when enabled by an administrator, `validateConsultantWebQuery` blocks any query containing phone numbers, emails, NINs, UUIDs, UGX figures, `"welile"`, or any name/number present in tool outputs.

### 5.4 Data Minimisation & Purpose Limitation (Sections 3 & 12)
1. **Least-Privilege Role Scoping:** A staff member's session can only invoke tools permitted for their role (`canUseTool` + database `SECURITY DEFINER` role checks + `mfa_required_for_staff` RLS).
2. **Column & Row Minimisation:**
   - `prepareToolOutputForModel` caps arrays and strips large redundant payloads before sending tool results to the model.
   - `zoe_ro.*` views expose only operational aggregates or masked identifiers (`mask_phone`).
3. **No Duplicate Question Text in Learning Logs:** `public.staff_assistant_learning_log` stores only a fixed topic enum (`ZOE_FIXED_TOPICS`), tool name, outcome, latency (`ms`), cost (`USD`), and thumbs rating — never a second copy of the question text.
4. **User Control over Memory (`Memory Off` & `Temporary Chat`):**
   - Staff can toggle **Memory off** in the `"..."` menu (`staff_assistant_preferences.memory_enabled = false`) so Zoe neither reads nor suggests notes.
   - Staff can enable **Temporary chat** (`temporary_chat = true`) so the turn reads no memory/history and writes nothing to `staff_assistant_conversations`, `staff_assistant_messages`, or `staff_assistant_learning_log`.

### 5.5 Storage & Retention Policy (Section 18 — 90-Day Retention)
- **90-Day Automated Retention Ceiling:** `public.staff_assistant_purge_old_history(p_days integer DEFAULT 90)` deletes conversations, messages, usage logs, unanswered logs, analyst query logs, and learning log rows older than **90 days** (`config.history_days`, bounded `7..90`).
- **Staff Right to Erasure / Hide History:** Any staff member can click **Clear my history** in the Zoe `"..."` menu (`public.staff_assistant_hide_my_history()`), which immediately hides their conversations from their My Space thread list, and can edit or delete any personal Zoe note at any time (`staff_assistant_delete_note`).

### 5.6 Access Control Matrix ("Who Can See What")

| Actor / Role | Own Chat Messages & Notes | Other Staff Members' Chat Text | Redacted Unanswered / Thumbs-Down Review Queue | Weekly Aggregate Topic & Cost Metrics | Curated Knowledge Base Editing |
| --- | --- | --- | --- | --- | --- |
| **Regular Staff Member (`employee`, ops roles)** | Read, export, & clear own history; view/edit/delete own notes | **No access** (blocked by RLS `user_id = (select auth.uid())`) | **No access** | **No access** | Read published entries allowed for role (`search_knowledge_base`) |
| **CRM / Manager / Executive (`crm`, `hr`, `coo`, `cfo`, `ceo`, `cto`, `manager`, `super_admin`)** | Own My Space threads only | **No access to normal staff chat threads** (`staff_assistant_messages` has no manager-read-all policy) | **Redacted only** (`staff_assistant_Redact_text` masks phones, emails, NINs, UUIDs, and UGX amounts before review) | Yes (`staff_assistant_weekly_manager_learning_view` — counts, topics, latency, cost only; **no individual staff text**) | Create/update entries via screen (`staff_assistant_upsert_knowledge_entry`, requires MFA AAL2) |

### 5.7 Open Items for the Owner, DPO, and Legal Counsel to Confirm
As required by engineering governance, **this document does not claim legal compliance**. Before relying on this DPIA for regulatory filings, the Owner, Data Protection Officer (DPO), and Ugandan legal counsel must verify and sign off on the following items:
1. **PDPO Registration Status:** Confirm that Welile Technologies Limited's registration with the **Personal Data Protection Office (PDPO)** under Section 29 of the Uganda DPPA 2019 is current and that internal AI-assisted reporting is reflected in Welile's Record of Processing Activities (RoPA).
2. **AI Provider Data Processing Terms (Zero-Training Confirmation):** Confirm in writing the Data Processing Addendum (DPA) and model-provider terms for the Lovable AI Gateway (`ai.gateway.lovable.dev` / Google Cloud Vertex AI / Gemini API) to verify that Welile prompts and tool outputs are **not** used to train public foundation models and are deleted after inference.
3. **Cross-Border Transfer Record (Section 19):** Have Ugandan legal counsel confirm whether the existing staff employment notice and customer privacy notice adequately cover cloud processing in `eu-west-1` (Supabase) and inference via the AI gateway, or whether an updated Staff AI Privacy Notice is required.
4. **90-Day Retention Schedule:** Confirm that the `90-day` purge schedule (`staff_assistant_purge_old_history(90)`) aligns with Welile's corporate document retention policy and Uganda Revenue Authority / financial audit retention rules (noting that Zoe only reads reports and never holds primary accounting records).
5. **DPO Sign-Off on DPIA:** Have Welile's appointed Data Protection Officer formally review and sign off on this DPIA under Regulation 12 of the Data Protection and Privacy Regulations 2021.
