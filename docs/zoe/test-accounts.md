# Zoe Dedicated Real-Evaluation Test Accounts (`npm run eval:zoe:real`)

**Rule (Part B, Item 2):**
> Build `npm run eval:zoe:real`. It signs in as dedicated test staff accounts, one per role, which the owner creates and flags as test (write the steps in `docs/zoe/test-accounts.md`; do not create accounts yourself). It calls the deployed `staff-assistant` with the real model and stores every request and response (no secrets) under `docs/zoe/eval-real/<date>/`.

---

## 1. Why Dedicated Owner-Created Test Accounts Are Required

1. **Zero Synthetic Auth Bypass**: `supabase/functions/staff-assistant` authenticates callers strictly via `Authorization: Bearer <JWT>`, resolves roles via `user_roles` (`enabled = true`), and checks AAL2 MFA (`requireStaffAal2`) on sensitive tools (`cfo`, `coo`, `ceo`, `hr`, `fin_ops`, `partner_ops`).
2. **No Self-Provisioned Accounts**: Per the CEO's and security rules, automated agents and scripts must **never** create staff accounts, grant roles, or mint bypass tokens in production.
3. **Clean Audit Trail**: Dedicated test accounts are flagged so their evaluation turns in `staff_assistant_messages`, `staff_assistant_learning_log`, and `staff_assistant_queries` can be inspected or filtered separately from organic staff usage.

---

## 2. Roles Needed for Full 120-Question + 60-Capability Coverage

Create one dedicated test staff account per role below (or assign the specific single role during a role-scoped evaluation pass):

| Role Key | Department / Workspace Scope | MFA (AAL2) Required? |
|---|---|---|
| `employee` | My Space personal tools (`get_my_*`, glossary, KB, manual, calculator) | No |
| `operations` | Tenant Ops (`get_tops_*`), Landlord Ops (`get_lops_*`), Agent Ops (`get_aops_*`) | No |
| `partner_ops` | Supporter & Partner Ops (`get_pops_*`, `get_pso_cohort_performance`) | Yes (for sensitive Supporter lists) |
| `fin_ops` | Financial Ops (`get_fops_*`) | Yes |
| `cfo` | CFO & Treasury (`get_cfo_*`, `zoe_ro` finance views) | Yes |
| `coo` | COO Command Center (`get_coo_overview`, cross-ops insights) | Yes |
| `ceo` | CEO Growth & Approvals (`get_ceo_growth_and_approvals`, Real-Use Dashboard) | Yes |
| `hr` | HR & Calling Detailed Reports (`get_hr_*`, team coaching summary) | Yes |
| `crm` | CRM Zoe Conversations & Teaching Queue (`staff_assistant_department_teaching_queue`) | Yes |

---

## 3. Step-by-Step Owner Setup Instructions

### Step 1 — Create the Accounts in Welile Admin / Supabase Auth
1. Sign in as a `super_admin` or `ceo` user in Welile (`https://welileapp.com/admin`) or open the Supabase Dashboard (`Authentication -> Users`).
2. Create dedicated test staff accounts using `@welile.com` emails reserved for evaluation, for example:
   - `zoe.eval.employee@welile.com`
   - `zoe.eval.operations@welile.com`
   - `zoe.eval.partner_ops@welile.com`
   - `zoe.eval.cfo@welile.com`
   - `zoe.eval.coo@welile.com`
   - `zoe.eval.ceo@welile.com`
   - `zoe.eval.hr@welile.com`
3. Complete TOTP MFA enrollment (`aal2`) on the accounts that test MFA-gated tools (`partner_ops`, `fin_ops`, `cfo`, `coo`, `ceo`, `hr`, `crm`).

### Step 2 — Flag Each Account as a Test Account in `profiles`
Run the following SQL as the database owner in the Supabase SQL Editor (replacing the email list with the emails you created):

```sql
UPDATE public.profiles
SET full_name = COALESCE(full_name, 'Zoe Eval Test Account') || ' [ZOE_TEST]'
WHERE email IN (
  'zoe.eval.employee@welile.com',
  'zoe.eval.operations@welile.com',
  'zoe.eval.partner_ops@welile.com',
  'zoe.eval.cfo@welile.com',
  'zoe.eval.coo@welile.com',
  'zoe.eval.ceo@welile.com',
  'zoe.eval.hr@welile.com'
);
```

### Step 3 — Provide Credentials to `npm run eval:zoe:real` at Runtime (Never Committed)
Export `ZOE_EVAL_TEST_ACCOUNTS_JSON` (or pass a local untracked file via `ZOE_EVAL_ACCOUNTS_FILE`) in your terminal session before running `npm run eval:zoe:real`:

```bash
export SUPABASE_URL="https://wirntoujqoyjobfhyelc.supabase.co"
export SUPABASE_ANON_KEY="<anon-key>"
export ZOE_EVAL_TEST_ACCOUNTS_JSON='{
  "employee": { "email": "zoe.eval.employee@welile.com", "password": "<password>" },
  "operations": { "email": "zoe.eval.operations@welile.com", "password": "<password>" },
  "partner_ops": { "email": "zoe.eval.partner_ops@welile.com", "password": "<password>", "totp_secret": "<optional-base32>" },
  "cfo": { "email": "zoe.eval.cfo@welile.com", "password": "<password>", "totp_secret": "<optional-base32>" },
  "coo": { "email": "zoe.eval.coo@welile.com", "password": "<password>", "totp_secret": "<optional-base32>" },
  "ceo": { "email": "zoe.eval.ceo@welile.com", "password": "<password>", "totp_secret": "<optional-base32>" },
  "hr": { "email": "zoe.eval.hr@welile.com", "password": "<password>", "totp_secret": "<optional-base32>" }
}'
npm run eval:zoe:real
```

---

## 4. What `npm run eval:zoe:real` Does and Stores

- Signs in as each configured test staff account via `supabase.auth.signInWithPassword` (and optional TOTP verification if `totp_secret` is provided).
- Calls the deployed `https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/staff-assistant` endpoint over HTTPS with the real Lovable AI Gateway model (`google/gemini-2.5-flash` / `google/gemini-2.5-pro`).
- Executes **120 core reliability questions** (40 general, 40 staff-record, 20 advice & research, 20 safety) plus **60 Part C capability questions**.
- Measures and records for every question:
  - Real time to first word (`ttfb_ms`) and total latency (`latency_ms`)
  - Requested model (`requested_model`) and actual gateway model (`gateway_model`)
  - Prompt/completion/cached tokens and estimated USD cost (`estimated_cost_usd`)
  - Turn `outcome`, `error_code`, and `tools_called`
  - Exact-number verification against the official report RPC called in the same session
- Saves sanitized requests and responses (all tokens, passwords, and secrets stripped) under `docs/zoe/eval-real/<YYYY-MM-DD>/summary.json` and `docs/zoe/eval-real/<YYYY-MM-DD>/runs.jsonl`.
- If `ZOE_EVAL_TEST_ACCOUNTS_JSON` is not present in the environment, `npm run eval:zoe:real` refuses to fabricate or simulate numbers and writes a manifest with `"status": "not_run"` explaining which env variables are required.
