# Prompt 2 Results — Fix the Brain: Real Models, Model-Drift Guard & Honest Evaluation Gate

**Recorded on:** `2026-11-04` (Africa/Kampala, EAT)  
**Branch:** `dev/zoe-final-prompt2`

---

## Executive Summary & Honest Status

1. **Why Zoe Replies Were Answered by `google/gemini-3.8-flash`:**
   - Live query against `public.staff_assistant_config` confirmed Zoe is configured for:
     - `model_fast = 'google/gemini-2.5-flash'`
     - `model_deep = 'google/gemini-2.5-pro'`
     - `web_research_enabled = false`
   - Live query against `public.staff_assistant_messages` (`WHERE role = 'assistant'`) confirmed **all 8 recorded assistant replies** in production had:
     - `requested_model = 'google/gemini-3-flash-preview'`
     - `gateway_model = 'google/gemini-3.8-flash'`
     - `model = 'google/gemini-3.8-flash'`
   - Because Google is retiring `gemini-2.5-flash` / `gemini-2.5-pro` ahead of the 1 December 2026 cutover, the Lovable AI Gateway is already pre-routing requests to `google/gemini-3.8-flash`.

2. **Item (1) — Real Evaluation Tool (`npm run eval:zoe:real`) & Owner Action Needed (`[ZOE_TEST]` Accounts Missing):**
   - We queried `public.profiles` in the live production database for any dedicated evaluation account (`WHERE email ILIKE '%zoe.eval%' OR full_name ILIKE '%ZOE_TEST%'`): **0 rows exist**.
   - Neither `ZOE_EVAL_TEST_ACCOUNTS_JSON` nor a search-provider key (`BRAVE_SEARCH_API_KEY` / `TAVILY_API_KEY`) is present in the environment.
   - Running `npm run eval:zoe:real` today wrote `docs/zoe/eval-real/2026-11-04/summary.json` with `"status": "not_run"`.
   - **Per Prompt 2 Rule (1):** We **stopped** before changing `staff_assistant_config.model_fast` / `model_deep` or turning on `web_research_enabled`. We did **not** create staff accounts, did **not** fabricate evaluation numbers, and do **not** mark model re-pinning "done" until the owner creates the 7 `[ZOE_TEST]` accounts and `npm run eval:zoe:real` produces a real, dated, non-`"not_run"` `summary.json`.

3. **Item (3) — Silent Model Drift Made Impossible (Completed & Verified Live):**
   - Applied migration `supabase/migrations/20261104190000_staff_assistant_model_drift_check.sql` (and rollback `supabase/rollbacks/20261104190000_staff_assistant_model_drift_check.rollback.sql`) to the live production database and recorded version `20261104190000` in `supabase_migrations.schema_migrations`.
   - Created `public.staff_assistant_check_model_drift(p_limit integer DEFAULT 50)` (`STABLE SECURITY DEFINER SET search_path = public`), which compares the most recent 50 assistant replies' actual `gateway_model` against `staff_assistant_config.model_fast` and `model_deep`.
   - Embedded `model_drift` into `public.staff_assistant_health()` and `public.staff_assistant_real_use_dashboard(p_days integer DEFAULT 14)`.
   - Updated `supabase/functions/staff-assistant/openai.ts`, `store.ts`, `schemas.ts`, and `index.ts` so both `chatCompletion` and `chatCompletionStream` capture `requestedModel` and the actual `model` returned by the gateway (from JSON `data.model`, SSE chunks `chunk.model`, or response headers `x-model` / `openai-model`) and log both on every reply.
   - Wired admin-visible model drift warnings into `src/components/zoe/ZoeHealthBanner.tsx` and `src/components/executive/crm/ZoeConversationsPanel.tsx` (`data-testid="zoe-model-drift-warning-banner"`).

4. **Item (4b) — Analyst Lane (`zoe_ro.*`) Promoted to an Open Offer (Completed & Verified):**
   - Updated `supabase/functions/staff-assistant/messages.ts` (`ANALYST_OPEN_OFFER`), `supabase/functions/staff-assistant/prompt.ts`, and `supabase/functions/staff-assistant/index.ts` so whenever no fixed certified report fits a staff member's Welile data question, Zoe openly offers:
     > `"I can look that up directly, with the usual checks — want me to try?"`
   - Added follow-up suggestion chip `"Yes — I can look that up directly, with the usual checks"` on unmatched turns when the caller's role is permitted to use `run_analyst_query`.

---

## 1. Live Database Verification of `public.staff_assistant_check_model_drift(50)`

Executing `SELECT public.staff_assistant_check_model_drift(50);` against the live production database returned:

```json
{
  "ok": true,
  "source": "staff_assistant_check_model_drift",
  "sample_limit": 50,
  "checked_count": 8,
  "mismatched_count": 8,
  "drift_detected": true,
  "configured_model_fast": "google/gemini-2.5-flash",
  "configured_model_deep": "google/gemini-2.5-pro",
  "dominant_gateway_model": "google/gemini-3.8-flash",
  "observed_models": [
    {
      "gateway_model": "google/gemini-3.8-flash",
      "requested_model": "google/gemini-3-flash-preview",
      "reply_count": 8,
      "matches_config": false,
      "last_seen_at": "2026-11-04T09:05:11.615295+00:00"
    }
  ],
  "warning_message": "Model drift detected: 8 of the last 8 Zoe replies were answered by google/gemini-3.8-flash, which does not match staff_assistant_config (model_fast: google/gemini-2.5-flash, model_deep: google/gemini-2.5-pro)."
}
```

Executing `SELECT public.staff_assistant_health();` against the live production database returned:

```json
{
  "ok": true,
  "status": "ok",
  "missing_tables": [],
  "missing_functions": [],
  "missing_views": [],
  "model_drift": {
    "ok": true,
    "source": "staff_assistant_check_model_drift",
    "sample_limit": 50,
    "checked_count": 8,
    "mismatched_count": 8,
    "drift_detected": true,
    "configured_model_fast": "google/gemini-2.5-flash",
    "configured_model_deep": "google/gemini-2.5-pro",
    "dominant_gateway_model": "google/gemini-3.8-flash",
    "warning_message": "Model drift detected: 8 of the last 8 Zoe replies were answered by google/gemini-3.8-flash, which does not match staff_assistant_config (model_fast: google/gemini-2.5-flash, model_deep: google/gemini-2.5-pro)."
  }
}
```

---

## 2. Exact Owner Steps Required to Unblock `npm run eval:zoe:real` (Quoting `docs/zoe/test-accounts.md`)

Per `docs/zoe/test-accounts.md` (Section 2 & Section 3), the owner must create the 7 dedicated test staff accounts and flag them with `[ZOE_TEST]` so `npm run eval:zoe:real` can sign in with real staff JWTs across roles (`employee`, `operations`, `partner_ops`, `cfo`, `coo`, `ceo`, `hr`) without any agent creating accounts or bypassing auth:

### Step 1 — Create the Accounts in Welile Admin / Supabase Auth
> 1. Sign in as a `super_admin` or `ceo` user in Welile (`https://welileapp.com/admin`) or open the Supabase Dashboard (`Authentication -> Users`).
> 2. Create dedicated test staff accounts using `@welile.com` emails reserved for evaluation, for example:
>    - `zoe.eval.employee@welile.com`
>    - `zoe.eval.operations@welile.com`
>    - `zoe.eval.partner_ops@welile.com`
>    - `zoe.eval.cfo@welile.com`
>    - `zoe.eval.coo@welile.com`
>    - `zoe.eval.ceo@welile.com`
>    - `zoe.eval.hr@welile.com`
> 3. Complete TOTP MFA enrollment (`aal2`) on the accounts that test MFA-gated tools (`partner_ops`, `fin_ops`, `cfo`, `coo`, `ceo`, `hr`, `crm`).

### Step 2 — Flag Each Account as a Test Account in `profiles`
> Run the following SQL as the database owner in the Supabase SQL Editor (replacing the email list with the emails you created):
>
> ```sql
> UPDATE public.profiles
> SET full_name = COALESCE(full_name, 'Zoe Eval Test Account') || ' [ZOE_TEST]'
> WHERE email IN (
>   'zoe.eval.employee@welile.com',
>   'zoe.eval.operations@welile.com',
>   'zoe.eval.partner_ops@welile.com',
>   'zoe.eval.cfo@welile.com',
>   'zoe.eval.coo@welile.com',
>   'zoe.eval.ceo@welile.com',
>   'zoe.eval.hr@welile.com'
> );
> ```

### Step 3 — Provide Credentials to `npm run eval:zoe:real` at Runtime (Never Committed)
> ```bash
> export SUPABASE_URL="https://wirntoujqoyjobfhyelc.supabase.co"
> export SUPABASE_ANON_KEY="<anon-key>"
> export ZOE_EVAL_TEST_ACCOUNTS_JSON='{
>   "employee": { "email": "zoe.eval.employee@welile.com", "password": "<password>" },
>   "operations": { "email": "zoe.eval.operations@welile.com", "password": "<password>" },
>   "partner_ops": { "email": "zoe.eval.partner_ops@welile.com", "password": "<password>", "totp_secret": "<optional-base32>" },
>   "cfo": { "email": "zoe.eval.cfo@welile.com", "password": "<password>", "totp_secret": "<optional-base32>" },
>   "coo": { "email": "zoe.eval.coo@welile.com", "password": "<password>", "totp_secret": "<optional-base32>" },
>   "ceo": { "email": "zoe.eval.ceo@welile.com", "password": "<password>", "totp_secret": "<optional-base32>" },
>   "hr": { "email": "zoe.eval.hr@welile.com", "password": "<password>", "totp_secret": "<optional-base32>" }
> }'
> npm run eval:zoe:real
> ```

---

## 3. Candidate Gemini Models Wired into `scripts/eval-zoe-real.mjs`

`scripts/eval-zoe-real.mjs` is configured with `CANDIDATE_GEMINI_MODELS`:

| Candidate Model | Role Tier Candidate | Notes |
|---|---|---|
| `google/gemini-3.8-flash` | `model_fast` (and/or `model_deep`) | The model the Lovable AI Gateway is already routing Zoe's live replies to (`8/8` production turns). |
| `google/gemini-2.5-flash-lite` | `model_fast` | Low-latency fast lookup comparison baseline. |
| `google/gemini-3-pro-preview` | `model_deep` | Multi-step Consultant, Analyst, and coaching comparison candidate. |

Once `ZOE_EVAL_TEST_ACCOUNTS_JSON` is provided and `npm run eval:zoe:real` completes a real run (`"status": "completed"` in `docs/zoe/eval-real/<date>/summary.json`), `staff_assistant_config.model_fast` and `staff_assistant_config.model_deep` will be updated in a committed migration using those measured answer-rate, figure-accuracy, TTFB, and cost numbers.

---

## 4. Status of Built Capabilities (Item 4)

| Capability | Current Status | Verification / Gate |
|---|---|---|
| **(a) Web research (`web_research_enabled`)** | Kept `false` in `public.staff_assistant_config` | Outbound query firewall (`validateConsultantWebQuery`), SSRF guard (`validateConsultantWebUrl`), and `"Outside source"` citation rules are built and unit-tested (`src/lib/zoe/__tests__/zoeConsultantMode.test.ts`), but neither `BRAVE_SEARCH_API_KEY` / `TAVILY_API_KEY` nor the `[ZOE_TEST]` accounts are configured yet. Kept `false` per rule (4a). |
| **(b) Analyst lane (`get_data_catalog` + `run_analyst_query` on `zoe_ro.*`)** | **Live & Openly Offered** | All 11 `zoe_ro.*` views and `assistant_staff_run_query` / `assistant_staff_get_data_catalog` are live and verified by `npm run guard:zoe-parity -- --check-live`. Updated `messages.ts`, `prompt.ts`, and `index.ts` so Zoe openly offers `"I can look that up directly, with the usual checks — want me to try?"` when no fixed report fits, labels every ad-hoc answer `"Ad hoc, not certified"`, and shows the SQL under **"Show the data"**. |
| **(c) Scheduled-report sender (`staff-assistant-schedule-runner`)** | **Code & DB RPCs Ready; Awaiting `[ZOE_TEST]` Recipient** | `staff_assistant_Claim_due_schedules` and `staff_assistant_complete_schedule_run` are live in production. End-to-end delivery test to a test staff recipient awaits creation of `zoe.eval.employee@welile.com` (`[ZOE_TEST]`). |
