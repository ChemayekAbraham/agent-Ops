# Supporter (Funder / Partner) System Reference Manual

**Status:** Definitive reference, reverse-engineered from live schema + repository source.
**Audience:** Engineers, finance, auditors, operations, compliance, future AI assistants.
**Method:** Read-only. `psql` against the live database (tables, views, `pg_policies`, `pg_proc`, `pg_trigger`, `general_ledger` aggregates) plus exhaustive source reads under `src/` and `supabase/functions/`.
**Convention used throughout:** *Observed* = verified in DB or source. *Reported* = stated in in-repo documentation but not independently verifiable in this pass (mostly `pg_cron`, whose schema is permission-denied to the audit role). *Inference* = reasoned conclusion, explicitly labelled.

---

## Table of Contents

1. [Terminology and Role Model](#1-terminology-and-role-model)
2. [Identity, Onboarding and Verification](#2-identity-onboarding-and-verification)
3. [Agreements and Contract Generation](#3-agreements-and-contract-generation)
4. [The Portfolio Engine](#4-the-portfolio-engine)
5. [Top-ups and Principal Growth](#5-top-ups-and-principal-growth)
6. [Renewals and Maturity](#6-renewals-and-maturity)
7. [The ROI / Returns Engine](#7-the-roi--returns-engine)
8. [Self Portfolio Management (PSM)](#8-self-portfolio-management-psm)
9. [Inbound Money — Deposits](#9-inbound-money--deposits)
10. [Wallet Architecture and Bucket Routing](#10-wallet-architecture-and-bucket-routing)
11. [Outbound Money — Withdrawals](#11-outbound-money--withdrawals)
12. [Capital Withdrawal and the 90-Day Notice](#12-capital-withdrawal-and-the-90-day-notice)
13. [Proxy and Managed Accounts](#13-proxy-and-managed-accounts)
14. [Standing Orders and Scheduled Payouts](#14-standing-orders-and-scheduled-payouts)
15. [Advance Recovery from Returns](#15-advance-recovery-from-returns)
16. [Ledger Category Matrix](#16-ledger-category-matrix)
17. [Security Model — RLS, Triggers, Definer Functions](#17-security-model--rls-triggers-definer-functions)
18. [Dashboards and Surfaces](#18-dashboards-and-surfaces)
19. [Notifications, Emails and Statements](#19-notifications-emails-and-statements)
20. [Scheduled Jobs (Cron Inventory)](#20-scheduled-jobs-cron-inventory)
21. [Failure Modes, Known Gaps and Remediation](#21-failure-modes-known-gaps-and-remediation)

---

## 1. Terminology and Role Model

### 1.1 One role, three names

The platform has exactly **one** database role for this persona: `supporter`. "Funder" and "Partner" are **UI labels**, not distinct roles or tables.

| Term | Where it appears | What it actually is |
|---|---|---|
| **Supporter** | `user_roles.role = 'supporter'`, `is_supporter()`, RLS policies, `src/components/supporter/` | The canonical role name |
| **Funder** | `/funder-onboarding`, `FunderApprovalGate`, `profiles.funder_verified_at`, `signup_source='funder-onboarding'` | A supporter who self-registered through the public funder funnel and therefore requires manager/COO approval |
| **Partner** | `partner_agreements`, `partner_self_*` (PSM), partner-ops exec panels, contract PDFs | A supporter viewed through the contractual/legal lens, and the label used for the self-managed product |

**Consequence for engineers:** there is no `src/components/funder/` directory. All funder UI lives in `src/components/supporter/`. Searching for "funder" alone will miss most of the module.

### 1.2 Role grant behaviour

Onboarding paths typically grant **all four public roles at once** — `tenant`, `agent`, `landlord`, `supporter`. Holding the `supporter` role is therefore *not* evidence of intent to invest; the presence of an `investor_portfolios` row is. Access decisions in supporter surfaces should key off portfolio existence or `funder_verified_at`, not the role grant alone.

### 1.3 Sub-personas

| Sub-persona | Distinguishing marker | Notes |
|---|---|---|
| Self-registered funder | `profiles.signup_source = 'funder-onboarding'` and `funder_verified_at IS NULL` | Hard-blocked from creating portfolios by DB trigger until approved |
| Agent-invited supporter | Row in `supporter_invites` | Onboarded with a temp password that is wiped by trigger after use |
| Managed / proxy partner | Active row in `proxy_agent_assignments` with `is_managed_account = true` | Money still credits the partner's own wallet; the agent delivers cash physically |
| Self-managed partner (PSM) | Rows in `partner_self_commitments` | Chooses which tenants to fund; accrual-based returns |
| Angel pool shareholder | Rows in `angel_pool_investments` | Equity-style, CEO-administered, separate from rent portfolios |

---

## 2. Identity, Onboarding and Verification

### 2.1 Onboarding paths

1. **Public self-signup** — `/funder-onboarding` → `profiles.signup_source='funder-onboarding'`. Creates the account but **not** the ability to fund.
2. **Agent-invited** — `supporter_invites` row created by an agent or manager (RLS restricts insert to those roles). Carries a temporary password; `trg_wipe_supporter_invite_temp_password` scrubs the plaintext after use/expiry. `trg_sync_house_reservation` keeps any linked house reservation in step with invite lifecycle.
3. **Bulk import** — staff-side load; portfolios created with `investor_id` initially null (staff-created portfolios bypass the funder-verification trigger, which only fires when `investor_id` is present).
4. **Proxy / managed** — an agent registers the partner on their behalf via `register-proxy-funder`, then serves as the physical cash conduit.

### 2.2 Email confirmation window

`funder-confirm-account` enforces a **strict 60-minute** validity window on the confirmation token. Expired links require re-issue; there is no silent extension.

### 2.3 Name validation

`_shared/validateFullName.ts` enforces at least two name tokens and rejects random-character strings. Applied at registration and retroactively via the profile completion gate.

### 2.4 Funder verification (the hard gate)

Three components work together:

- **RPC `approve_self_registered_funder(_target_user, _reason)`** — SECURITY DEFINER. Requires `manager` or `coo`. Requires `_reason` of at least 10 characters. Writes `profiles.funder_verified_at` / `funder_verified_by`, and logs to both `audit_logs` and `system_events`.
- **RPC `reject_self_registered_funder(...)`** — mirror path.
- **Trigger `trg_enforce_funder_verified_for_portfolio` on `investor_portfolios`** — raises `self_registered_funder_not_verified` if the investor's `signup_source = 'funder-onboarding'` and `funder_verified_at IS NULL`. Skipped when `investor_id IS NULL`.

Helper reads: `get_funder_approval_status()`, `is_funder_approved()`. UI gate: `FunderApprovalGate.tsx` / `FunderActivationModal.tsx`. Staff queue: `PendingFunderApprovals.tsx`.

**Why this matters:** the gate is enforced at the **database trigger** layer, not merely in UI. A compromised client cannot fund a portfolio for an unverified self-registered funder.

### 2.5 Session security

`SupporterInactivityLock.tsx` enforces a **5-minute idle timeout** on supporter surfaces, requiring full re-authentication (not just a soft re-prompt). This is stricter than any other persona in the platform, reflecting the value at risk on these screens.

---

## 3. Agreements and Contract Generation

| Object | Detail |
|---|---|
| `partner_agreements` | Partner-scoped RLS: create / view / update own. Signatures are stored as **base64 data-URLs** inside the row. |
| `partner_agreement_company_defaults` | Managers insert/update; all authenticated read. Holds company-side boilerplate (registered address, signatory, terms). |
| `PartnerAgreementSignOff.tsx` | Capture + e-sign surface. |
| `AgreementHtmlPreview.tsx` | HTML preview of the rendered agreement. |
| `renderAgreementPdf.ts` | Client-side PDF path (primary). |
| `_shared/partnerContractPdf.ts` | Server-side renderer, used as fallback and for server-initiated sends. |

**Known history:** the `/funder-onboarding` contract PDF originally dropped several form fields because rendering was client-only and ran before state hydration. The server-side renderer was introduced to make field capture deterministic. When debugging a "blank fields" report, confirm which of the two renderers produced the artifact.

---

## 4. The Portfolio Engine

### 4.1 `investor_portfolios` — the core record

The single most important supporter table. It is simultaneously a contract record, a capital balance and a payout schedule.

Key columns: `investor_id`, `investment_amount`, `roi_percentage`, `contribution_date`, `duration_months`, `maturity_date`, `next_roi_date`, `total_roi_earned`, `auto_reinvest`, `status`, `account_name`, `portfolio_code`, `pending_renewal_effective_date`.

**Status values observed:** `awaiting_partner_details`, `active`, `cancelled` (queries also reference `matured`).

**Live distribution at time of audit:** 993 `active`, 6 `cancelled`, 1 stuck in `awaiting_partner_details`.

### 4.2 Creation paths

| Path | Mechanism | Funds move? |
|---|---|---|
| Pending / WIP | `create_pending_portfolio()` — issues a `WIP` portfolio code and a completion token | **No.** No ledger entry at this stage. |
| Completion | `complete_partner_portfolio()` — token-gated (`portfolio_completion_tokens`, partner may read own token only; no client insert/update policy exists, issuance is backend-only) | Yes, on completion |
| Approval | `approve_pending_portfolio()` | Yes |
| Direct staff creation | Insert with `investor_id` set | Yes, via AFTER INSERT trigger |
| COO instant top-up | `coo-wallet-to-portfolio` edge function | Yes, immediately |

### 4.3 `trg_enforce_portfolio_funding_at_creation`

AFTER INSERT trigger. Posts the funding legs and, critically, carries the **double-debit guard**:

> If a wallet debit for the **same user and same amount** already exists within **±30 minutes**, funding is not posted again.

Idempotency key form: `portfolio-funding-<portfolio_id>`.

**Origin:** a real production incident (user `0701822382`) where the app-side funding path and the trigger both executed, debiting 100,000 UGX twice for a single investment action. The guard was introduced as the fix; duplicate deductions were reversed manually.

**Inference / residual risk:** the guard is time-and-amount heuristic, not a hard uniqueness constraint. Two *genuinely distinct* fundings of an identical amount by the same user within 30 minutes would be silently collapsed to one. This is the correct trade-off for the observed failure mode but should be understood before high-frequency funding is enabled.

### 4.4 `trg_enforce_investor_portfolio_field_immutability`

This is what makes the deliberately broad client `UPDATE` policy on `investor_portfolios` safe. For any authenticated writer **not** holding `manager`, `coo`, `cfo`, `ceo`, `super_admin`, `financial_ops` or `partner_ops`, every financial, identity, status and verification field is silently reset to `OLD.*`. In practice a supporter can edit only `account_name`.

**Design pattern to internalise:** across this module, RLS is intentionally permissive on the row and restrictive on the **column**, enforced by trigger. Reading policies alone will over-estimate the client's power.

### 4.5 Balance semantics — the principal trap

`investment_amount` is a **mutable running total**. It includes compounded ROI and merged top-ups. It is *not* the capital the partner contributed.

`_shared/contributed-principal.ts` → `getContributedPrincipal(supabase, portfolioId, currentInvestmentAmount)` returns true contributed capital:

1. Find the most recent principal-changing manual edit (`audit_logs.action_type='edit_investment_portfolio'` where `metadata.changes.investment_amount.from != .to`).
2. Sum `audit_logs` rows with `action_type='roi_compounded'`, `table_name='investor_portfolios'`, taking `metadata.roi_amount` — **only those logged after that edit** (a manual edit is assumed to have already absorbed prior compounds; this prevents double-subtraction).
3. Subtract from the current amount.
4. On any query error, **fail open** — return the raw amount and log a warning.

**Rule:** any partner-facing statement, email or figure describing "your contribution" must call `getContributedPrincipal`. Confirmed wired into the top-up email path in `process-supporter-roi` and `approve-portfolio-topup`.

**Gap — see §21:** `process-supporter-roi`'s auto-reinvest branch updates `investment_amount` and posts `roi_reinvestment` ledger legs but does **not** write a `roi_compounded` audit_logs row. Auto-compounded ROI is therefore invisible to the subtraction logic, inflating reported "contributed principal".

---

## 5. Top-ups and Principal Growth

There is **no dedicated top-up table.** Top-ups ride on `pending_wallet_operations` with `operation_type='portfolio_topup'`.

### 5.1 Lifecycle

1. Partner (or COO on their behalf) initiates a top-up → row in `pending_wallet_operations`, status `pending` / `awaiting_verification` / `approved`.
2. Money is **parked**. `investment_amount` is unchanged. The partner sees a pending top-up, not a larger portfolio.
3. The top-up merges into principal only when the **next ROI cycle** is processed — so a top-up made mid-cycle earns nothing until the cycle boundary.
4. Merge is executed by DB routine `public.merge_paidout_topups()`, on cron `merge-paidout-topups-7pm` (16:00 UTC / 19:00 EAT).

### 5.2 Inline merge is disabled

`process-supporter-roi` contains a full inline merge implementation behind `INLINE_TOPUP_MERGE_ENABLED = false`. It is dead code retained for reference. If re-enabled it would gate on `isPortfolioRoiDue()` (`roiDateGate.ts`), sum matching `pending_wallet_operations`, bump `investment_amount`, flip operations to `completed`, post `pending_portfolio_topup` (cash_out, platform) + `partner_funding` (cash_in, platform), write `audit_logs`, and email via `buildPartnershipTopupRequest` using `getContributedPrincipal` for the "previous value" baseline.

**Operational note:** if partners report "my top-up isn't showing", the correct diagnostic order is (a) is the operation `approved`? (b) has the portfolio's ROI date passed? (c) did `merge-paidout-topups-7pm` run?

### 5.3 COO instant top-up

`coo-wallet-to-portfolio` bypasses the parking model for staff-driven top-ups. It debits either the partner's withdrawable (`recipient_type='user'`) or float (`recipient_type='operational_wallet'`), posts `partner_funding`, carries a duplicate guard on `(portfolio_id, txGroupId)`, and re-checks strict balance before large top-ups.

---

## 6. Renewals and Maturity

### 6.1 `apply_portfolio_renewal(p_portfolio_id, p_renewed_by, p_reason)`

- Resets `total_roi_earned` to **0** (new cycle starts clean).
- Extends `maturity_date` and `next_roi_date`.
- **Idempotent** — skips if a renewal was already applied the same day.
- Mirror: `reverse_portfolio_renewal()`.

### 6.2 `auto_renew_due_portfolios(p_limit default 500)`

Batch sweep. Also **manually invokable** from `PartnersOpsDashboard.tsx` (a button, line ~137) — this is important because no `cron.schedule()` entry for it was found in migrations. In practice renewal is at least partly ops-triggered.

### 6.3 Renewal inside the ROI job

`process-supporter-roi` runs its own renewal sweep **before** paying out: portfolios with `status='active'`, `maturity_date <= today`, `pending_renewal_effective_date IS NULL` get `apply_portfolio_renewal` called with a CFO/manager `renewed_by`. Each call is individually try/caught and non-blocking.

### 6.4 `portfolio_renewals` table

Authenticated users may insert own rows; ops read broadly. The insert has no financial effect on its own — the actual renewal is applied by the definer function.

---

## 7. The ROI / Returns Engine

### 7.1 `process-supporter-roi` (728 lines) — the main engine

**Invocation:** `pg_cron`, reported daily at **06:00 UTC**. Registered out-of-band (not in migrations) because the SQL embeds project URLs and keys.

**Auth:** none inside the function. It runs on `SUPABASE_SERVICE_ROLE_KEY` and assumes only cron reaches it.

**Kill switches:**
- `PAYOUT_PAUSED` constant (currently `false`) — hard short-circuit.
- `checkTreasuryGuard(supabase, "any")` — blocks during maintenance freeze.

**Eligibility:**
```sql
select id, rent_amount, supporter_id, funded_at, next_roi_due_date,
       total_roi_paid, roi_payments_count
from rent_requests
where supporter_id is not null
  and funded_at is not null
  and status in ('funded','disbursed','completed')
```

**Exclusions built up-front:**
- `pausedSupporterIds` — supporters with an `investment_withdrawal_requests` row where `rewards_paused = true` and status in (`pending`,`approved`). Requesting your capital back pauses your returns.
- `autoReinvestMap` — `investor_portfolios` with `auto_reinvest = true` and `status='active'`, keyed by `investor_id`, **first match only** (a partner with several auto-reinvest portfolios funnels all ROI into whichever matched first — see §21).

**Cycle detection — strict 30 days:**
- If `next_roi_due_date` is set: skip when `dueDate > now`.
- Else `firstDue = funded_at + 30 days`; skip when `firstDue > now`.

**Rate:** hard-coded flat **15%** of `rent_amount`:
```js
roiAmount = Math.round(Number(rr.rent_amount) * 0.15)
```
There is **no config lookup** on this path. `investor_portfolios.roi_percentage` is used for emails and top-up merges but not for this calculation.

**Idempotency:** insert into `supporter_roi_payments` with unique `(rent_request_id, payment_number)`. A `23505` violation is treated as "already processed" and the loop continues. This — not a ledger idempotency key — is the primary guard for the credit leg.

### 7.2 Branch A — auto-reinvest (compounding)

- `investor_portfolios.investment_amount += roiAmount`.
- Ledger via `create_ledger_transaction`:
  - Leg 1: `roi_expense`, `cash_out`, `ledger_scope='platform'`, `linked_party='platform'`, `source_table='supporter_roi_payments'`.
  - Leg 2: `roi_reinvestment`, `cash_in`, `ledger_scope='platform'`, `source_table='investor_portfolios'`.
- **Both legs are platform-scope.** No wallet leg. Capital grows inside the portfolio and never touches the wallet — so compounded ROI is not withdrawable until the portfolio itself is liquidated.
- Notification `type:'earning'` + `buildPartnerCompoundRequest` email (rate derived as `returnAmount/initialAmount`, not read from a stored percentage).

### 7.3 Branch B — wallet credit (cash)

- `resolveManagedProxy(supabase, supporter_id)` (`_shared/partnership-emails.ts`) looks up `proxy_agent_assignments` where `beneficiary_id = partnerId`, `is_active`, `is_managed_account`, `approval_status='approved'`, most recent first.
- **The partner's own wallet is always the credit recipient**, even under a managed proxy. The agent must later withdraw on the partner's behalf; the agent never receives a direct credit.
- Ledger legs:
  - Leg 1: `user_id = supporter_id`, `roi_expense`, `cash_out`, `ledger_scope='platform'`, `linked_party='platform'`.
  - Leg 2: `user_id = supporter_id`, `roi_wallet_credit`, `cash_in`, `ledger_scope='wallet'`, `recipient_type='user'`, `wallet_bucket='withdrawable'`.
- Immediately after: `apply_roi_advance_recovery(...)` with key `sup-roi-{rentRequestId}-{paymentNumber}` (§15). Wrapped in try/catch — a recovery failure never blocks the credit.
- Notifications: single partner notification, or **two** under managed proxy ("Processing" to partner, "Proxy Payout Ready for Delivery" to agent).
- Emails: Stage-1 "Processing" (`buildReturnsProcessingRequest`, txn id `ROI-{rrId8}-{paymentNumber}`, `payoutMethod:'Wallet'`). Stage-2 "Paid" (`returns-disbursement-confirmation`) is dispatched later by `approve-withdrawal` when funds physically leave.

### 7.4 Per-iteration close-out (both branches)

`rent_requests` updated: `next_roi_due_date = now + 30 days`, `total_roi_paid += roiAmount`, `roi_payments_count = paymentNumber`. Then `logSystemEvent('roi_distributed', ...)`. Errors are collected per row into `results.errors[]`; the loop never aborts wholesale.

### 7.5 The `roi_accrued` myth

`SYSTEM_CONTEXT.md` and `EarningsExplainer.tsx` both present `roi_accrued` as a real state ("accrual precedes cash"). **It is not implemented in `process-supporter-roi`.** That function writes `supporter_roi_payments` at status `paid`/`reinvested` and posts cash legs with no antecedent accrual row or check. Confirmed by the ledger category matrix: **no `roi_accrued` category exists in `general_ledger` at all.**

Genuine accrual-then-pay separation exists **only** in the PSM path (§8).

### 7.6 Other returns engines

| Engine | Product | Formula | Ledger |
|---|---|---|---|
| `process-investment-interest` | `investment_accounts` (status `approved`, balance > 0) | Flat **15% monthly**, no rounding, no compounding | `roi_expense` (platform) + `roi_wallet_credit` (wallet) — **but this leg omits `recipient_type`/`wallet_bucket`**, unlike `process-supporter-roi`. See §21. |
| `apply_welile_homes_monthly_interest()` | Welile Homes tenant savings (not supporter capital) | **Compound 5%/month**: `total_savings = total_savings * 1.05` | **No ledger legs at all** — mutates `total_savings` directly |
| `accrue_partner_self_returns` / `pay_partner_self_cycles` | PSM | Prorated daily accrual then cash | Proper two-stage — §8 |

`process-investment-interest` has per-account idempotency on `(account_id, payment_month)` and ensures a `wallets` row exists via upsert. **No cron entry was found for it** in migrations or the documented job table — treat it as legacy or manually invoked until proven otherwise.

---

## 8. Self Portfolio Management (PSM)

The self-managed product: a partner picks specific tenants/plans to fund rather than buying into a pooled portfolio. This is the **only** part of the module with a correct accrual-before-cash architecture.

### 8.1 Tables

| Table | Role |
|---|---|
| `partner_self_commitments` | The partner's overall commitment: term, monthly rate, `next_payout_at`, `term_end_at`, `total_earned`, `total_paid`, status (`active` → `matured`) |
| `partner_self_plan_claims` | Soft-lock on a fundable plan while the partner decides; expired by `expire_partner_self_claims` |
| `partner_self_funding_lines` | Individual funded positions: `principal`, `live_at`, `completed_at`, status |
| `partner_self_earnings` | Per-line accrual rows, unique on `(line_id, cycle_end)` |
| `partner_self_payout_cycles` | Per-cycle aggregate, unique on `(commitment_id, cycle_end)`, carries `ledger_group_id` once paid |
| `partner_self_audit` | `psm_audit()` writes here |

**RLS on all six: SELECT only** (owner or ops). There are **no client INSERT/UPDATE policies whatsoever.** Every mutation flows through SECURITY DEFINER RPCs. This is the reference implementation of the correct pattern for this codebase.

### 8.2 `accrue_partner_self_returns(p_as_of default CURRENT_DATE)` — accrual, no cash

For each `partner_self_commitments` with `status='active'` and `next_payout_at <= p_as_of`:

- `cycle_end = next_payout_at`, `cycle_start = next_payout_at - 1 month`, `days = cycle_end - cycle_start`.
- Upsert the `partner_self_payout_cycles` row.
- For each funding line (`active`/`completed`, `live_at` set):
  ```
  days_live = LEAST(cycle_end, completed_at or cycle_end)
            - GREATEST(cycle_start, live_at)
  amount    = round( principal * monthly_rate/100 * days_live / days_in_cycle )
  ```
  → inserted into `partner_self_earnings`. **Prorated daily within a monthly cycle** — a line that went live mid-cycle earns only its live days. (Contrast the flat 15% of the pooled engine.)
- Roll `SUM(amount) WHERE status <> 'void'` into the cycle's `total_amount` / `lines_count`.
- Advance `next_payout_at += 1 month`, accumulate `total_earned`, flip to `matured` if `term_end_at` has passed.
- `psm_audit(..., 'returns_recognised', ...)`.

Returns `{commitments_processed, total_recognised, as_of}`.

### 8.3 `pay_partner_self_cycles(p_limit default 200)` — cash

- Selects cycles with `status='pending' AND cycle_end <= CURRENT_DATE`, oldest first.
- **Idempotency:** if `ledger_group_id IS NOT NULL`, mark `paid` and skip. If `total_amount <= 0`, mark `void`.
- `create_ledger_transaction(entries, idempotency_key := 'psm-payout-' || c.id)`:
  - Leg 1: `roi_expense`, `cash_out`, platform.
  - Leg 2: `roi_wallet_credit`, `cash_in`, wallet, `recipient_type='user'`, `wallet_bucket='withdrawable'`.
- Cycle → `paid`, stamp `paid_at` + `ledger_group_id`; matching `partner_self_earnings` flip `accrued` → `paid`; `total_paid` incremented.
- `apply_roi_advance_recovery(partner_id, total_amount, c.id, 'psm-payout-'||c.id)` — exceptions swallowed.
- `system_events('roi_distributed')` + `psm_audit(..., 'returns_paid')`.
- Per-row failure → `status='failed'`, `failure_reason = SQLERRM`.

Returns `{cycles_paid, total_paid, skipped, failed}`.

### 8.4 Supporting RPCs

`partner_self_claim_plans`, `partner_self_release_claims`, `partner_self_confirm_commitment`, `partner_self_list_fundable_plans`, `partner_self_portfolio`, `partner_self_nearing_payouts(p_days=7)` (staff-gated ops visibility), `expire_partner_self_claims`, `psm_is_partner`.

### 8.5 UI

`SelfPortfolioFundingCard.tsx` and `FunderCapitalOpportunities.tsx` — responsive stacked cards showing tenant name, rent amount and key data, with bulk selection. Deliberately non-overlapping card layout for mobile.

### 8.6 Scheduling status

**No `cron.schedule()` for `accrue_partner_self_returns` or `pay_partner_self_cycles` exists in migrations.** Either they are registered out-of-migration like the rest, or PSM returns are currently ops-triggered. This must be resolved before PSM scales — see §21.

---

## 9. Inbound Money — Deposits

### 9.1 `deposit_requests`

Columns of interest: `user_id`, `agent_id`, `amount`, `status`, `provider`, `transaction_id`, `transaction_date`, `deposit_purpose`, `purpose_audit`, `auto_match_audit`, `auto_approved`, `batch_run_id`, `audit_flagged`, `auto_credit_review_status` (`confirmed|reversed`), `processed_by`.

`deposit_purpose` enum: `operational_float`, `personal_deposit`, `partnership_deposit`, `personal_rent_repayment`, `other`.

Triggers: `trg_deposit_request_auto_rematch`, `trg_dr_bridge_enqueue`, `trg_enforce_agent_personal_deposit_confirmation`, `trg_enforce_auto_deposit_requires_ledger`, `trg_enforce_unique_deposit_tid`, `trg_flag_operational_float_tid_duplicates`, `trg_guard_deposit_reference_uniqueness`, `trg_log_deposit_guardrail_revert`, `trg_log_deposit_status`.

### 9.2 `approve-deposit` — the FLOAT-ALWAYS rule

**This is the single most consequential and most misunderstood fact in supporter money movement.**

As of the 2026-07-29 change, the function hardcodes:
```js
isFloatDeposit = true   // unconditional
```
Every approved deposit — **regardless of `deposit_purpose`** — posts as `agent_float_deposit`, `wallet_bucket='float'`, `recipient_type='operational_wallet'`.

`deposit_purpose` survives only as analytics/audit metadata in `purpose_audit`. It has **zero routing effect**.

| `deposit_purpose` | Documented intent | Actual routing |
|---|---|---|
| `operational_float` | float | float ✓ |
| `personal_deposit` | withdrawable | **float** |
| `partnership_deposit` | partner capital | **float** |
| `personal_rent_repayment` | rent | **float** (repayment application runs downstream) |
| `other` | fallback | float, with `console.warn` |

**Stale documentation warning:** lines ~845–862 of the same file describe a "STRICT BACKEND-AUTHORITY CONTRACT… every approved deposit lands in withdrawable_balance". That block is unreachable — `isFloatDeposit` is already forced true above it. Do not trust it. It is a leftover from a prior iteration.

**Consequence for supporters:** a partner depositing capital lands it in `float_balance`, which `get_user_available_balance` does not count as withdrawable. Moving it requires an explicit staff bucket transfer (`admin-float-to-withdrawable`, `finops-wallet-move`, `ops-bucket-transfer`).

### 9.3 Other `approve-deposit` behaviours

- **Actions:** `approve | reject | reopen`. Bulk up to 100 ids. `reject` requires a rejection reason of ≥10 characters (server-enforced). `reopen` is manager-only, `rejected` → `pending`.
- **System auto-credit path:** `system_auto_credit: true` with `Authorization: Bearer <service_role_key>` lets the Gmail poller act as the deposit owner.
- **Idempotency guard:** before approving, scans `general_ledger` for an existing `wallet_deposit`/`agent_float_deposit` cash_in keyed on `source_table='deposit_requests', source_id=<id>`. If found it reconciles status only and does not re-credit. (Introduced after a production triple-credit incident.)
- **Ordering and non-rollback:** ledger post → status update (verified; zero rows updated raises hard error + `approve_status_update_failed`) → `apply_wallet_movement`. If the wallet write fails after the first two committed, **there is no rollback** — the ledger remains source of truth and ops must reconcile against `v_user_wallet_strict`. Logged as `approve_wallet_writer_failed` + `system_events('wallet.writer_failed')`.
- **`withRetry()`** wraps transient RPC failures (timeout, connection, deadlock, serialization) up to 3× with backoff, specifically targeted at deposits ≥ 10M UGX.
- **Receipts:** auto-approved deposits send SMS + email (`operational-float-credit` or `partner-wallet-deposit`) naming the bucket actually credited.

### 9.4 Gmail auto-match

`gmail_transactions.linked_deposit_request_id → deposit_requests`. Poller: `gmail-poll-transactions`. Referenced routines: `auto_create_deposits_from_gmail`, `auto_match_email_deposits`. Auto-credit is gated behind an `eligibleAutoApprove` check before `approve-deposit` is called with `system_auto_credit: true`.

---

## 10. Wallet Architecture and Bucket Routing

### 10.1 `wallets` is a view, not a table

Columns: `id, user_id, balance, locked_balance, currency, withdrawable_balance, float_balance, advance_balance`. It carries `INSTEAD OF INSERT/UPDATE` triggers (`wallets_view_instead_of_insert`, `wallets_view_instead_of_update`).

The insert trigger is SECURITY DEFINER, redirects to `wallets_physical`, and **silently drops any client-supplied `balance`, `withdrawable_balance`, `float_balance` or `advance_balance`**. This was the fix for the `register_proxy_funder_spoof` finding (migration `20260512181008`), where legacy raw `INSERT INTO wallets` could let a caller assert their own balances.

### 10.2 `wallet_balances_projection`

PK `user_id`. Columns: `withdrawable, float_balance, advance_balance, pending_holds, restricted_held, total_visible, ledger_version, updated_at`. RLS: own row, plus `cfo/coo/ceo/manager/financial_ops`.

### 10.3 The strict withdrawable read

```sql
get_user_available_balance(p_user_id uuid) RETURNS numeric
  -- SELECT withdrawable FROM wallet_balances_projection WHERE user_id = p_user_id, default 0
```
Only `withdrawable`. Float, advance and pending are never withdrawable through this function.

### 10.4 `apply_wallet_movement` — the sole writer

Two overloads exist:

- `(p_user_id, p_category, p_amount, p_direction, p_recipient_type)` — routing-aware, used by all current code.
- `(p_user_id, p_category, p_amount, p_direction)` — **legacy overload still present**. Calling it bypasses the router. See §21.

### 10.5 `recipient_type` — Wallet Routing v2

| `recipient_type` on a wallet-scope leg | Destination bucket |
|---|---|
| `'user'` | `withdrawable_balance` |
| `'operational_wallet'` | `float_balance` |
| **omitted / NULL** | `wallet_bucket` stays NULL and the projection **defaults the money to withdrawable** |

**Omission is not neutral — it is a withdrawable leak.** The in-code warning is explicit: forgetting `recipient_type` results in "silently redirecting agents' float deposits into their withdrawable bucket."

### 10.6 Historical tagging debt

The ledger matrix (§16) shows the majority of `roi_wallet_credit` legs — 1,083 rows totalling 1.17bn UGX — carry **NULL** `recipient_type` and `wallet_bucket`, versus 488 correctly tagged rows. These predate Routing v2. They default to withdrawable, which is the intended destination for ROI, so the outcome is right, but any future change to the NULL-default behaviour would retroactively reclassify 1.17bn UGX of history.

---

## 11. Outbound Money — Withdrawals

### 11.1 `withdrawal_requests`

A wide table. Notable groups:

- **Identity/amount:** `user_id`, `amount`, `reason`, `client_request_id` (unique per user), `receipt_token` (unique, auto-generated).
- **Approval chain:** `manager_approved_at/by`, `cfo_approved_at/by`, `coo_approved_at/by`, `fin_ops_reference/verified_by/at/approved_by/at`.
- **Payout instrument:** `payout_method` (default `mobile_money`), `mobile_money_number/provider/name`, `bank_name/account_number/account_name`, `payout_proof(+type)`, `payout_code`.
- **Dispatch:** `assigned_cashout_agent_id`, `preferred_cashout_agent_id`, `auto_dispatched`, `dispatched_at`, `dispatch_round`, `dispatch_expires_at`, `dispatch_claimed_by/at`, `dispatch_escalated_at`, `priority_level`.
- **Proxy/beneficiary:** `agent_id`, `initiated_by`, `proxy_partner_id`, `beneficiary_id`, `linked_party`.
- **Special:** `landlord_payout_id`, `processing_started_at/by`.

### 11.2 State machine

```
pending → requested → manager_approved → cfo_approved → fin_ops_approved
        → (approved | processing) → completed
                     ↘ rejected  (staff-only, any point)

dispatch sub-state: dispatch_round / expires_at / claimed_by / claimed_at / escalated_at
landlord_payout_id branch: bypasses BOTH ledger-match and KYC-cap triggers
proxy branch: ledger check runs against agent_id, settled later via proxy_payout_settlements
```

Live status distribution (8,196 rows): 5,494 `completed`, 2,032 `rejected` (~25%), 210 `expired`, 55 `cancelled`, 2 `pending`, 1 `processing`, 1 `failed`, 1 `re_approved_for_recovery`.

### 11.3 `enforce_withdrawal_ledger_match()`

- Rejects `amount <= 0`, logging to `withdrawal_attempt_failures`, `ERRCODE 22023`.
- **Bypasses entirely** when `landlord_payout_id IS NOT NULL` (float-backed, deducted before insert).
- **Commission detection:** matches `reason` against a fixed lowercase set (`'commission payout'`, `'cash-out commission'`, …). On match, the available-funds check runs against commission specifically: `agent_commission_earned` (cash_in) − `agent_commission_withdrawal` − `agent_commission_used_for_rent` (cash_out) − pending commission withdrawals.
- **Proxy handling:** `v_is_proxy := proxy_partner_id IS NOT NULL AND agent_id IS NOT NULL AND agent_id <> user_id`. When proxy, the balance check runs against **`agent_id`**, i.e. the proxy agent's own wallet funds the payout; the partner is made whole through `proxy_payout_settlements`. This was the fix for the "Lilian ledger mismatch" incident.

### 11.4 `enforce_kyc_withdrawal_cap()`

- Skipped for `landlord_payout_id IS NOT NULL` and for `proxy_partner_id IS NOT NULL`.
- `get_kyc_effective_limits(user_id).frozen` → raises `'Account frozen pending review'`, `HINT='kyc_frozen'`.
- **Accounts younger than 30 days: 50,000 UGX/day default cap.**
- Per-user override via `kyc_profiles.daily_withdrawal_cap_ugx`. A value ≤ 0 **disables the cap entirely**; any positive value replaces the default. (This is the mechanism used for the `bwayo mark` manual override.)
- A `v_graduated` exemption path exists, keyed off prior completed advances/withdrawals.

### 11.5 `proxy_payout_settlements`

`id, approval_id (unique), withdrawal_id, partner_id, agent_id, amount_settled, settled_at, notes`. RLS: agent and partner see their own; `manager`/`cfo` see all. It is the reconciliation record for cash a proxy agent fronted.

---

## 12. Capital Withdrawal and the 90-Day Notice

Capital withdrawal is a **separate pipeline** from wallet withdrawal, with its own table and its own approval chain.

### 12.1 `investment_withdrawal_requests`

`id, user_id, amount, reason, status (default 'pending'), requested_at, earliest_process_date DEFAULT now() + '90 days', processed_at, processed_by, rejection_reason, rewards_paused (DEFAULT true), partner_ops_approved_at/by, coo_approved_at/by, cfo_processed_at/by`.

Approval chain: **partner_ops → coo → cfo_processed**. Distinct from the manager/cfo/coo chain on `withdrawal_requests`.

RLS: own-row INSERT and SELECT (role `public`). Inserting a *request* is correctly client-writable; no disbursement power attaches.

Live: 9 rows, all `pending`.

### 12.2 `rewards_paused` — the coupling to ROI

Because the column defaults to `true`, **requesting your capital back immediately stops your returns.** `process-supporter-roi` skips any supporter with such a row in `pending` or `approved`. Support staff must understand this: a partner who "just wanted to check the process" and filed a request will stop earning.

### 12.3 The 90-day notice is NOT trigger-enforced

Searched `pg_proc` for any `enforce_*notice*` function: **none exists.**

Enforcement consists of exactly three things:
1. The **column default** `now() + '90 days'` — a client or RPC that omits the field gets the floor automatically.
2. A **presentational countdown** in `src/components/supporter/InvestmentWithdrawButton.tsx` (`processDate.setDate(+90)`, `differenceInDays`).
3. **Manual staff discipline** across the 3-stage approval.

Nothing prevents an operator from setting an earlier `earliest_process_date` or flipping `status` before it elapses. **This is a genuine control gap — see §21.**

---

## 13. Proxy and Managed Accounts

### 13.1 `proxy_agent_assignments`

The authorising record: `beneficiary_id`, agent, `is_active`, `is_managed_account`, `approval_status`, expiry. Helper functions `is_proxy_agent_for_partner()`, `get_proxy_partner_balance()`.

### 13.2 Withdrawal authorisation

RLS policy *"Proxy agents can submit withdrawals for their partner"* requires **all** of: `agent_id = auth.uid()`, `initiated_by = auth.uid()`, `proxy_partner_id = user_id`, `beneficiary_id = user_id`, `user_id <> auth.uid()`, and an active, approved, unexpired assignment. Six simultaneous conditions — a strong policy.

### 13.3 Cash-in: `agent_deposit_to_partner(p_agent_id, p_partner_id, p_amount, p_notes)`

- Requires an active `proxy_agent_assignments` row.
- Debits the agent's `wallets.balance` (**legacy `balance` column, not the projection** — noted as a divergence).
- Credits the partner.
- **Commission: 1%** — `v_commission := ROUND(p_amount * 0.01)`. Category `wallet_transfer`. Tracking id `PDEP-XXXXXXXX`.

### 13.4 Cash-in: `agent-invest-for-partner`

- **Commission: 2%** — `Math.round(amount * 0.02)`. Category and `earning_type`: `proxy_investment_commission`.

**Correction to a widely-held assumption:** there is no `partner_commission` ledger category anywhere in `general_ledger`. The 2% applies to proxy **investment**, not to deposits. Deposits carry 1% under `wallet_transfer`. `approve-wallet-operation` also computes a 2% figure in a separate branch (line ~582), presumably the same investment flow.

### 13.5 ROI under managed proxy

Money credits the **partner's wallet**, never the agent's. The agent receives a "Proxy Payout Ready for Delivery" notification and a `buildProxyManagedPayoutRequest` email, then withdraws on the partner's behalf through the proxy withdrawal path. `enforce_managed_proxy_roi_routing` guards against misrouting; violations land in `managed_proxy_roi_routing_violations` (CFO/manager SELECT only).

### 13.6 Reversal: `reverse-proxy-roi-approval`

Staff-only (`super_admin/manager/cfo/coo/operations`), requires a reason of ≥10 characters, max 50 ids per call. Targets `pending_wallet_operations` with `category IN ('roi_payout','supporter_platform_rewards')` and `status='approved'`.

Guards, in order:
1. **Idempotency** — `reverse-roi-approval-<opId>` checked against `general_ledger.idempotency_key`.
2. **Settlement guard** — if `SUM(proxy_payout_settlements.amount_settled) > 0`, the reversal is blocked ("already settled by a delivered withdrawal").
3. **Balance guard** — the credited wallet must still hold ≥ the amount in `withdrawable_balance` (1 UGX rounding tolerance).

Then it locates the original balanced group via the `roi_wallet_credit` cash_in leg matching `reference_id` + `amount`, pulls all legs sharing `transaction_group_id`, and posts mirror-reversal legs with flipped direction, `category='system_balance_correction'`, `classification='admin_correction'`, `solvency_bypass_reason='duplicate_reversal'`, `skip_balance_check: true`.

Finally: rolls `investor_portfolios.next_roi_date` back **one calendar month** (re-entering the "Nearing Payout" queue), cancels the operation with reversal metadata, writes `audit_logs('proxy_roi_approval_reversed')` and `system_events('proxy.roi_approval.reversed')`.

---

## 14. Standing Orders and Scheduled Payouts

### 14.1 Tables

- `scheduled_payouts`: `created_by, target_user_id, amount (>0), category_id, sub_category, reason, frequency (daily|weekly|monthly|interval), day_of_month (1–28), day_of_week, interval_days, enabled, last_run_at, next_run_at`. **RLS: CFO / super_admin only, all CRUD.**
- `scheduled_payout_runs`: `scheduled_payout_id, status, ran_at` — per-cycle idempotency.

### 14.2 `process-scheduled-payouts`

- `checkTreasuryGuard(adminClient, "any")` first.
- Selects `enabled = true AND next_run_at <= now()` (optionally one `payout_id`).
- **Idempotency:** if a `scheduled_payout_runs` row exists with `status='success'` and `ran_at >= payout.next_run_at`, execution is skipped **but `next_run_at` is still advanced** via `computeNextRun()`. Manual re-triggers cannot double-pay.
- `computeNextRun()` handles `daily`, `weekly` (`day_of_week`), `interval` (`interval_days`) and `monthly`.
- **Category map** (`catMap`) → `{walletCat, platformCat, impact}`:

| `category_id` | wallet category | platform category | impact |
|---|---|---|---|
| `roi_payout` | `roi_wallet_credit` | `roi_expense` | expense |
| `agent_commission` | agent commission legs | mirrored | expense |
| `payroll` | `salary_payout` | mirrored | expense |
| `marketing_expenses` / `research_development` / `operational_expense` | `system_balance_correction` | mirrored | expense |
| `correction_credit` | — | — | neutral |
| `wallet_transfer_out` | `wallet_transfer` | mirrored | — |

- **Money actually moves via an internal `fetch` to `cfo-direct-credit`** with `Authorization: Bearer <service_role_key>` and body flag **`system_requisition_credit: true`**. In `cfo-direct-credit` (line ~153) this sets `isSystemAutoCredit`, and line ~172 stamps `callerRoles = ['system_requisition_credit']` for audit attribution.
- **Failure mode:** if the HTTP call fails, the error body is logged and no success row is written, so the next sweep retries. (This flag being absent was the root cause of the platform-wide `Unauthorized` failures that stalled Grace Paul Ochieng's standing order.)

---

## 15. Advance Recovery from Returns

### 15.1 `apply_roi_advance_recovery(p_user_id, p_roi_amount, p_source_id, p_idempotency_key)`

- No-op if `p_user_id IS NULL` or `p_roi_amount <= 0`.
- **Idempotency:** checks `general_ledger.idempotency_key = 'roi_adv_rec_' || p_idempotency_key`; if present returns `{recovered: 0, skipped: 'already_recovered'}`.
- Iterates `agent_advances` where `agent_id = p_user_id`, `recovery_source = 'roi'`, `status IN ('active','overdue')`, `outstanding_balance > 0`, `roi_recovery_percent > 0`, ordered **`issued_at ASC` (oldest first, FIFO)**.
- **Take formula:**
  ```
  v_take = round( LEAST( outstanding_balance,
                         v_remaining,
                         p_roi_amount * roi_recovery_percent / 100 ) )
  ```
  Capped by what's left of the advance, what's left of the ROI after earlier advances took their cut, and the configured percentage of the **original** ROI amount.
- Ledger: `agent_repayment` cash_out (wallet, `recipient_type='user'`) + `agent_repayment` cash_in (platform, `recipient_type='operational_wallet'`).
- Updates `outstanding_balance = GREATEST(0, outstanding - v_take)` and status → `completed` / `overdue` (if `expires_at < now`) / `active`.
- Writes `agent_advance_ledger` (`opening_balance, amount_deducted, closing_balance, deduction_status='full'|'partial', recovery_source='roi', roi_amount, recovery_percent`).
- Returns `{recovered, net_roi, advances[]}`.

**Callers:** `process-supporter-roi` (wallet-credit branch) and `pay_partner_self_cycles`. Both try/catch and non-blocking.

### 15.2 Precedence

The **only** deduction chained directly to an ROI credit is advance recovery:

```
ROI credit posts → withdrawable rises → apply_roi_advance_recovery claws back
   (oldest advance first, capped % each) → remainder stays withdrawable
```

Promissory-note deductions and Layer-A write-downs run on independent schedules and are *not* chained to the ROI event.

### 15.3 `process-promissory-deductions` (capital in, not returns out)

Treasury-guarded. Selects `promissory_notes` with `status='activated'`, `partner_user_id IS NOT NULL`, `next_deduction_date <= today`. If `wallets.balance < note.amount` it **skips silently — no partial deduction, no error.** Calls `set_ledger_authorization()`, then posts `wallet_deduction` (cash_out, wallet) → `partner_funding` (cash_in, platform) with key `promissory-<noteId>-<today>`. Updates `total_collected`; `fulfilled` if `once_off`, else `next_deduction_date += 1 month`.

Validation trigger `trg_validate_promissory_note`: enum `contribution_type`, `deduction_day` 1–28 for monthly, `amount > 0`, valid status.

Live: **31 `pending`, 4 `activated`, 0 fulfilled/defaulted/cancelled** — a notable funnel bottleneck.

### 15.4 `apply_layer_a_writedown(p_user_id, p_dry_run default true)`

Not a returns function — an ops tool for historical wallet drift. CFO/manager/service_role only. Reads `phantom_wallet_drift` (`status='open'`, `drift_type='negative_overdebit'`). Computes `v_strict_net` (signed sum of wallet-scope `production` + `admin_correction` legs) and `v_post_apr_credits` (production wallet credits since 2026-04-01, excluding correction/float/advance categories). **Blocks** when the user has spendable post-April credits and a positive net. `writedown_amount = ABS(LEAST(strict_net, 0))` — only the negative portion is absorbed. Live run creates/updates `wallet_fresh_start_anchors` and zeroes `wallet_ledger_baseline`.

---

## 16. Ledger Category Matrix

Live `general_ledger` aggregates, ROI/interest scope:

| category | direction | scope | count | sum (UGX) |
|---|---|---|---|---|
| `roi_expense` | cash_out | platform | 2,142 | 2,255,106,800 |
| `interest_expense` | cash_out | platform | 2,096 | 7,671,472 |
| `roi_wallet_credit` | cash_in | wallet | 1,571 | 1,693,240,035 |
| `pending_portfolio_topup` | cash_in | platform | 767 | 1,767,650,559 |
| `pending_portfolio_topup` | cash_out | platform | 759 | 1,672,773,345 |
| `roi_reinvestment` | cash_in | platform | 541 | 561,464,265 |
| `roi_payout` | cash_in | wallet | 89 | 186,243,231 |
| `roi_wallet_credit` | cash_in | platform | 35 | 33,684,740 |
| `pending_portfolio_topup` | cash_in | wallet | 26 | 86,352,400 |
| `roi_payout` | cash_out | wallet | 14 | 121,415,498 |
| `pending_portfolio_topup` | cash_out | wallet | 9 | 6,642,811 |
| `roi_wallet_credit` | cash_out | wallet | 2 | 1,040,000 |
| `roi_reinvestment` | cash_in | wallet | 1 | 6,729,419 |
| `roi_wallet_credit` | cash_out | platform | 1 | 50,000 |
| `roi_expense` | cash_out | wallet | 1 | 6,729,419 |

Bucket-tagging split on `roi_wallet_credit` (wallet, cash_in): **1,083 rows untagged** (1.17bn) vs **488 tagged** `user`/`withdrawable` (521m).

`wallet_deduction`: 307 rows cash_out wallet (941m), 186 cash_in platform (514m), plus a handful of correctly-tagged rows.

### 16.1 The canonical ROI pair

```
roi_expense       cash_out  platform         (platform liability discharged)
roi_wallet_credit cash_in   wallet           recipient_type='user'
                                             wallet_bucket='withdrawable'
```

### 16.2 `roi_payout` is a different stage

The 89 + 14 `roi_payout` rows are **not** produced by `process-supporter-roi`. They belong to the proxy-approval/withdrawal delivery stage (`pending_wallet_operations.category IN ('roi_payout','supporter_platform_rewards')`). Treat `roi_wallet_credit` as *credit* and `roi_payout` as *delivery*.

### 16.3 Categories that do NOT exist

Frequently assumed but **absent from `general_ledger`**: `roi_accrued`, `partner_commission`, `portfolio_funding`, `investment_deposit`, `deposit_approved`.

### 16.4 All partner/investment/supporter categories that DO exist

```
agent_investment_commission     angel_pool_investment        agent_proxy_investment
coo_proxy_investment            coo_proxy_investment_reversal
partner_funding                 proxy_investment_commission  proxy_partner_withdrawal
roi_reinvestment                supporter_capital            supporter_facilitation_capital
supporter_platform_rewards      supporter_rent_fund          wallet_to_investment
```

Note the four distinct supporter-capital flavours (`supporter_capital`, `supporter_facilitation_capital`, `supporter_platform_rewards`, `supporter_rent_fund`) — these are not interchangeable and any capital reporting must enumerate all four.

`interest_expense` (2,096 rows, average ~3,660 UGX) is a separate legacy/float-interest category untouched by the ROI engine.

---

## 17. Security Model — RLS, Triggers, Definer Functions

### 17.1 The governing pattern

Across the whole module:

> **Permissive row-level RLS + restrictive column-level triggers + SECURITY DEFINER functions for all real mutation.**

Reading `pg_policies` alone will systematically over-estimate what a client can do. Always check for a companion immutability trigger.

### 17.2 RLS inventory (79 policies across 25+ tables)

| Table | Pattern | Assessment |
|---|---|---|
| `supporter_roi_payments` | **Explicit `Deny direct ROI payment inserts` / `Deny direct ROI payment updates`** policies for `authenticated`, plus own/staff SELECT | Strongest control in the module. Only definer functions and cron can write ROI payments. |
| `supporter_capital_ledger` | Staff INSERT only; supporter SELECT own | Correctly non-client-writable |
| `partner_self_*` (6 tables) | **SELECT only**, no INSERT/UPDATE policies at all | Reference implementation |
| `investor_portfolios` | Investors SELECT/UPDATE own; agents scoped; managers/COO full | Broad UPDATE, locked by immutability trigger |
| `investment_withdrawal_requests` | Own INSERT/SELECT (`public`) | Request-only, no disbursement power — appropriate |
| `promissory_notes` | Agents create/update own pending; admin full; partners view own | Gated by validation trigger + admin-only status transitions |
| `partner_agreements` | Partners create/view/update own | Non-financial |
| `portfolio_action_requests` | Partners insert/select own; ops select/update all | Request/approval workflow |
| `portfolio_completion_tokens` | Partner reads own token only; **no INSERT/UPDATE policy** | Backend-only issuance |
| `angel_pool_config` | CEO write, authenticated read | |
| `angel_pool_investments` | System insert + own SELECT + staff SELECT, protected by `trg_enforce_angel_share_amount_match` | |
| `lender_partners` | Owner `ALL`, staff view/update | Broad but owner-scoped |
| `managed_proxy_roi_routing_violations`, `partner_funding_backfill_log` | Staff/admin SELECT only | Audit-only |
| `roi_payout_schedules` | Ops only | |
| `supporter_invites` | Agent/manager only | |
| `supporter_referrals` | System insert (`public`), own SELECT | Relies on `WITH CHECK`; worth periodic re-verification against arbitrary crediting |
| `supporter_agreement_acceptance` | Own insert/select | Non-financial acknowledgement |
| `partner_escalations` | Managers `ALL` | |

**Conclusion: no client-writable financial ledger was found in the supporter module.**

### 17.3 Trigger inventory (15 on matching tables)

| Table | Trigger | Purpose |
|---|---|---|
| `investor_portfolios` | `trg_enforce_investor_portfolio_field_immutability` | Column lock for non-privileged writers |
| `investor_portfolios` | `trg_enforce_funder_verified_for_portfolio` | Blocks unverified self-registered funders |
| `investor_portfolios` | `trg_enforce_portfolio_funding_at_creation` | Funding + ±30-min double-debit guard |
| `angel_pool_investments` | `trg_enforce_angel_share_amount_match` | Shares must match amount paid |
| `promissory_notes` | `trg_validate_promissory_note` | Enum/range/amount validation |
| `supporter_invites` | `trg_wipe_supporter_invite_temp_password` | Scrubs plaintext temp password |
| `supporter_invites` | `trg_sync_house_reservation` | Reservation lifecycle sync |
| `partner_self_*` ×4 | `psm_touch_*` | Timestamps |
| `lender_partners`, `partner_agreements`, `partner_agreement_company_defaults`, `portfolio_action_requests` | `update_updated_at_column` | Timestamps |

### 17.4 SECURITY DEFINER functions (51)

- **Portfolio lifecycle:** `create_pending_portfolio`, `approve_pending_portfolio`, `complete_partner_portfolio`, `apply_portfolio_renewal`, `reverse_portfolio_renewal`, `auto_renew_due_portfolios`, `schedule_roi_payout`, `generate_portfolio_code`.
- **Funder verification:** `approve_self_registered_funder`, `reject_self_registered_funder`, `get_funder_approval_status`, `is_funder_approved`, `ops_link_landlord_funder`.
- **ROI safety:** `apply_roi_advance_recovery`, `get_duplicate_roi_credits(window_seconds, lookback_days)`.
- **PSM:** the ten `partner_self_*` / `psm_*` functions listed in §8.4.
- **Angel pool:** `ceo_angel_pool_shareholder_action`, `get_supporter_pool_stats`.
- **Proxy/float:** `agent_deposit_to_partner`, `get_proxy_partner_balance`, `is_proxy_agent_for_partner`.
- **Misc:** `search_supporters`, `list_joined_partners[_cursor]`, `welile_mission_funders`, `notify_new_investment_account`, `notify_investment_request_status_change`, `notify_supporters_new_opportunity`, `credit_supporter_referral_bonus`, `wipe_supporter_invite_temp_password`, `is_supporter` (two overloads), `log_investment_tx_to_ledger`, `trg_auto_log_supporter_capital`.

### 17.5 Resolved security findings

| Finding | Fix |
|---|---|
| `register_proxy_funder_spoof` | `wallets` is a view; `INSTEAD OF INSERT` trigger (migration `20260512181008`) redirects to `wallets_physical` and drops client-supplied balance columns |
| Self-registered funder funding before approval | `trg_enforce_funder_verified_for_portfolio` + approval RPCs — DB-level, not UI-level |
| `kyc_level_config` public select | Read intentionally public (threshold config, no PII); write restricted to `super_admin` |
| `credit_access_limits_self_insert` | Self-assignment of credit limits closed; definer/staff only |
| `welile_homes_subscriptions_tenant_self_update_balances` | Immutability-trigger pattern: non-financial self-update allowed, balance fields locked |

*(Exact policy SQL for the last two was not pulled verbatim; direction inferred from migration naming and the codebase's consistent pattern.)*

---

## 18. Dashboards and Surfaces

### 18.1 Supporter-facing

| Component | Purpose |
|---|---|
| `src/components/dashboards/SupporterDashboard.tsx` (710 lines) | Main home. Direct reads of `general_ledger`, `investor_portfolios`, `rent_requests` under own-row RLS. |
| `FunderApprovalGate.tsx`, `FunderActivationModal.tsx` | Pre-approval gate |
| `SupporterInactivityLock.tsx` | 5-minute idle re-auth |
| `FunderCapitalOpportunities.tsx`, `FunderDirectHouseListing.tsx`, `FunderSelectionConfirmDialog.tsx` | Opportunity selection, stacked cards, bulk selection |
| `FunderQuickActions.tsx`, `FunderTopUpDialog.tsx` | Actions and top-ups |
| `FunderEarningsAssumptions.tsx`, `FunderEarningsBreakdown.tsx` | Earnings projection display |
| `PortfolioSummaryCards.tsx`, `InvestmentBreakdownSheet.tsx`, `InvestmentPackageSheet.tsx`, `InvestmentCalculator.tsx`, `InvestmentGoals.tsx`, `InvestmentAccountsDrawer.tsx` | Portfolio detail |
| `InvestmentWithdrawButton.tsx` | Capital withdrawal + 90-day countdown (presentational) |
| `AngelSharesTab.tsx`, `SupporterROILeaderboard.tsx` | Angel pool, leaderboard |
| `src/components/partner/SelfPortfolioFundingCard.tsx` | PSM funding entry |
| `PartnerAgreementSignOff.tsx`, `AgreementHtmlPreview.tsx` | Agreements |

### 18.2 Staff / executive

| Component | Purpose |
|---|---|
| `executive/PartnersOpsDashboard.tsx` | Portfolios, frozen accounts; manual `auto_renew_due_portfolios(500)` button |
| `executive/PendingFunderApprovals.tsx` | Funder approve/reject queue |
| `executive/PendingPartnerRequests.tsx`, `NewPartnersPanel.tsx` | Onboarding queues |
| `executive/PartnerCapitalFlow.tsx`, `PartnerFinancialActivity.tsx`, `PartnerOpsBrief.tsx` | Capital analytics |
| `executive/PartnerOpsWithdrawalQueue.tsx` | Partner withdrawal queue |
| `executive/PartnerSMSBroadcast.tsx` | Bulk SMS |
| `executive/FunderFunnelPanel.tsx`, `FunderFunnelDrilldown.tsx`, `FunderEngagementPanel.tsx` | Acquisition funnel |
| `cfo/CFOPartnerInvestments.tsx`, `CFOPartnerPayoutProcessing.tsx`, `CFOROIRequests.tsx`, `CFOAllocationReturnApprovals.tsx` | CFO controls |
| `cfo/DuplicateRoiCreditsPanel.tsx` | Surfaces `get_duplicate_roi_credits` |
| `pages/cfo/InvestorReportPage.tsx` (924 lines) | Investor/financial statement generator |

---

## 19. Notifications, Emails and Statements

### 19.1 Two-stage ROI email

| Stage | Trigger | Builder / template |
|---|---|---|
| 1 — Processing | ROI wallet credit posts in `process-supporter-roi` | `buildReturnsProcessingRequest`, txn id `ROI-{rrId8}-{paymentNumber}`, `payoutMethod:'Wallet'`, flag `isManagedByAgent` |
| 2 — Paid | Funds physically leave, in `approve-withdrawal` | `returns-disbursement-confirmation` |

Other builders: `buildPartnerCompoundRequest` (auto-reinvest), `buildProxyManagedPayoutRequest` (to the agent), `buildPartnershipTopupRequest` (top-up merge, uses `getContributedPrincipal` for the baseline).

All dispatched fire-and-forget through `dispatchTransactionalEmail` — **email failure never blocks money movement**, and conversely a missing email is not evidence that a credit failed.

### 19.2 Notifications

`type:'earning'` for compounding; per-credit notifications for cash; dual notifications under managed proxy carrying `rent_request_id`, `roi_amount`, `payment_number`, `proxy_assignment_id`. A manager summary ("💼 ROI Processed") is POSTed to `notify-managers` at the end of each run.

### 19.3 Statements

- **Principal rule:** all partner-facing statements must use `getContributedPrincipal`, never raw `investment_amount`.
- **`send-funder-statement`** is, despite the name, an **SMS sender** (Africa's Talking / `attemptYoolaPrimary`). It contains no reference to `getContributedPrincipal`. Do not assume it emits the capital statement.
- **`InvestorReportPage.tsx`** uses `useFinancialStatements()` (`src/hooks/useFinancialStatements.ts`), pulling `general_ledger`, `investor_portfolios`, `rent_requests`, `agent_advances`, `promissory_notes`. Periods: today / 7d / 30d / month / YTD / all. Comparisons: DoD / WoW / MoM / YoY. CSV export via `exportToCSV`; a presentation-export affordance exists. All queries are client-side under CFO route guard.
- **Running Balance** is hidden from end users platform-wide and gated behind finance/audit roles in `LedgerEntryDetailDrawer.tsx`.

---

## 20. Scheduled Jobs (Cron Inventory)

`select jobname, schedule, active from cron.job` → **`ERROR: permission denied for schema cron`**. The audit role cannot read the job table. Convention (documented in `send-system-context/doc.ts` L603) is that cron rows are inserted with the insert tool, **never** via migration, because they embed project URLs and keys — so migrations are not a reliable inventory either.

### 20.1 Reported jobs (from in-repo documentation — not independently verified)

| Job | Cadence | Target |
|---|---|---|
| ROI daily sweep | Daily 06:00 UTC | `process-supporter-roi` |
| Wallet auto-charge | Daily 06:00 UTC | `auto-charge-wallets` |
| Fee revenue recognition | Daily 06:00 UTC | `recognize-fee-revenue-daily` |
| Agent advance deductions | Daily 18:00 EAT | `process-agent-advance-deductions` |
| Auto-apply pending top-ups | Daily 18:00 EAT | `auto-apply-pending-topups` |
| Top-up merge into principal | 16:00 UTC / 19:00 EAT | `merge-paidout-topups-7pm` → `merge_paidout_topups()` |
| Welile Homes monthly interest | Weekly/monthly | `apply_welile_homes_monthly_interest()` |
| Portfolio renewals | Weekly/monthly | `apply-scheduled-portfolio-renewals` |
| Landlord payout | Monthly | `landlord-monthly-payout` |
| Advance recovery sweep | Every 15 min | `sweep-agent-advance-recovery` |
| Withdrawal dispatch | Every 1 min | `redispatch-withdrawals`, `release-stale-claims` |
| Ledger reconciliation | Daily 02:15 UTC | `nightly-wallet-ledger-reconciliation` |
| **Total** | — | **98 jobs (93 active, 5 inactive)** |

### 20.2 Jobs found in migrations (observed)

`detect-withdrawable-drift-alerts-every-15min` (`20260429051219`), `drift-pivot-test-hourly` (`20260507094652`), `reconcile-wallets-from-pivot` (`20260506115147`), `reconcile-agent-landlord-float` (`20260730103624`), `reconcile-credited-deposit-profiles` (`20260603095333`).

### 20.3 Functions with NO discoverable schedule

`process-investment-interest`, `accrue_partner_self_returns`, `pay_partner_self_cycles`, `expire_partner_self_claims`, `auto_renew_due_portfolios`.

For `auto_renew_due_portfolios` it is **confirmed** that a manual trigger exists (`PartnersOpsDashboard.tsx`). For the other four, scheduling status is unknown and must be verified by an operator with `cron` schema access before any SLA is promised to partners. **This is the highest-priority open verification item.**

---

## 21. Failure Modes, Known Gaps and Remediation

### 21.1 Quantified failure surfaces

| Signal | Table / mechanism | Observed | Reading |
|---|---|---|---|
| Wallet routing corrections | `wallet_routing_v2_corrections` | **146 rows** | Real, non-trivial correction volume in proxy/managed flows |
| Raw routing violations | `wallet_routing_violations` | **0 rows** | Superseded — prevention now works (`enforce_managed_proxy_roi_routing`) |
| Projection drift alerts | `wallet_projection_drift_alerts` | **0 rows** | 15-min detector currently clean |
| Duplicate ROI credits | `get_duplicate_roi_credits()` RPC | On-demand | Surfaced in `DuplicateRoiCreditsPanel` |
| Partner funding backfill | `partner_funding_backfill_log` | **74 rows** | Evidence of a historical funding-record correction campaign |
| Promissory funnel | `promissory_notes.status` | 31 pending / 4 activated / 0 fulfilled | Severe activation bottleneck |
| Portfolio orphan | `investor_portfolios.status` | 1 row stuck `awaiting_partner_details` | Created but never completed via token flow |
| Capital withdrawals | `investment_withdrawal_requests` | 9 rows, all `pending` | Nothing has ever been processed through this pipeline |
| Wallet withdrawals | `withdrawal_requests` | 2,032 rejected of 8,196 (~25%) | High rejection rate warrants root-cause analysis |

### 21.2 Open gaps, ranked

**G1 — 90-day capital notice is not enforced by the database (§12.3).**
Only a column default, a UI countdown and staff discipline. An operator can approve early with no obstruction.
*Remedy:* a BEFORE UPDATE trigger on `investment_withdrawal_requests` raising unless `now() >= earliest_process_date`, with an explicit, logged, CFO-only override path.

**G2 — Auto-reinvested ROI is invisible to `getContributedPrincipal` (§4.5, §7.2).**
The reinvest branch never writes a `roi_compounded` audit_logs row, so compounded returns are counted as contributed capital in statements and emails. Either another (unlocated) manual "compound ROI" action is the intended producer of those rows, or the figure is simply wrong for every auto-reinvest partner.
*Remedy:* write `audit_logs(action_type='roi_compounded', table_name='investor_portfolios', metadata.roi_amount)` inside the reinvest branch, then backfill from the 541 `roi_reinvestment` legs.

**G3 — Scheduling of PSM and legacy interest engines is unverified (§20.3).**
`accrue_partner_self_returns` and `pay_partner_self_cycles` have no discoverable schedule. If they are not scheduled, self-managed partners are not being paid on time.
*Remedy:* an operator with `cron` access must enumerate `cron.job` and confirm; add missing entries.

**G4 — `deposit_purpose` is vestigial; all deposits go to float (§9.2).**
Partner capital deposits land in `float_balance` and are not withdrawable without staff intervention. The file's own documentation contradicts its code.
*Remedy:* decide the intended contract, then either restore purpose-based routing or delete the misleading comment block and the enum's unused values.

**G5 — Legacy `apply_wallet_movement` 4-arg overload still exists (§10.4).**
Any call to it bypasses the bucket router; per §10.5 an untagged wallet leg defaults to **withdrawable**, which is a real-money leak vector.
*Remedy:* drop the overload once call-site analysis confirms zero usage.

**G6 — `process-investment-interest` omits `recipient_type`/`wallet_bucket` (§7.6).**
Its `roi_wallet_credit` leg is untagged, relying on the withdrawable default. Correct outcome today, fragile by construction.
*Remedy:* stamp `recipient_type:'user'`, `wallet_bucket:'withdrawable'` explicitly.

**G7 — `roi_accrued` is documented but not implemented (§7.5).**
Docs and UI promise accrual-before-cash on the pooled path; the code pays cash directly. Auditors reading `SYSTEM_CONTEXT.md` will be misled.
*Remedy:* either implement accrual on the pooled path (mirroring PSM) or correct the documentation and `EarningsExplainer` copy.

**G8 — 15% ROI rate is hardcoded in two engines (§7.1, §7.6).**
`investor_portfolios.roi_percentage` exists and is used for emails, creating a divergence risk between the rate shown and the rate paid.
*Remedy:* read the rate from the portfolio (or a config table) and treat 15% as a fallback only.

**G9 — `autoReinvestMap` takes the first matching portfolio only (§7.1).**
A partner with multiple auto-reinvest portfolios has all ROI compounded into whichever the query returned first.
*Remedy:* key the map on the specific portfolio linked to the rent request, not on `investor_id`.

**G10 — Drift view names in code comments do not exist in the database (§referenced throughout).**
`wallet_strict_drift_view`, `wallet_anchored_drift_view`, `phantom_wallet_drift` and `wallet_withdrawable_drift_alerts` are named in error messages and comments but return zero matches in `pg_views`. Live equivalents are `wallet_pivot_drift_view`, `v_pivot_drift`, `rent_request_formula_drift`, `v_agent_landlord_float_reconciliation`. `v_user_wallet_strict` is referenced in `approve-deposit`'s own error text but could not be re-verified (transient DB auth timeout).
*Remedy:* ops runbooks reference non-existent objects — update the error strings and the runbook to the live names.

**G11 — Promissory deductions fail silently on insufficient balance (§15.3).**
No error, no partial deduction, no alert. A partner can miss months of committed capital with no signal to anyone.
*Remedy:* log a `system_event` and notify partner-ops on skip.

**G12 — Post-ledger wallet-write failures are deliberately not rolled back (§9.3).**
Correct for ledger integrity, but it depends on a reconciliation job that references a view of unconfirmed existence (G10).
*Remedy:* confirm the reconciliation path is live and alarmed.

### 21.3 Triage guide — "partner says X"

| Symptom | Check, in order |
|---|---|
| "My returns stopped" | (1) Open `investment_withdrawal_requests` with `rewards_paused=true` — this alone stops ROI. (2) Portfolio `status`. (3) `next_roi_due_date` vs today. (4) Did the 06:00 UTC job run? |
| "My top-up isn't showing" | (1) `pending_wallet_operations` status. (2) Has the ROI date passed? Top-ups merge only at the cycle boundary. (3) Did `merge-paidout-topups-7pm` run? |
| "My deposit isn't withdrawable" | Expected under FLOAT-ALWAYS (§9.2). Needs a staff bucket transfer. |
| "I was charged twice" | `general_ledger` for two funding legs within 30 minutes; the guard should have blocked it — if not, the app path and trigger both fired outside the window. |
| "I can't withdraw" | (1) Frozen? `get_kyc_effective_limits`. (2) Account < 30 days → 50k/day cap. (3) `get_user_available_balance` (withdrawable only). (4) For proxy, the check is against the **agent's** wallet. |
| "Capital withdrawal is taking forever" | 90-day notice + 3-stage approval; and note that **zero** requests have ever been processed through this pipeline. |
| "Agent says they paid me" | `proxy_payout_settlements` for the settlement record; `wallet_routing_v2_corrections` if misrouted. |

---

## Appendix A — Canonical Sequence: Standard ROI Credit

1. Cron (~06:00 UTC) invokes `process-supporter-roi` with the service-role key.
2. `PAYOUT_PAUSED` check, then `checkTreasuryGuard` — abort on maintenance freeze.
3. Renewal sweep: `apply_portfolio_renewal` for matured, un-renewed active portfolios.
4. Fetch eligible `rent_requests` (funded, supporter set, status funded/disbursed/completed).
5. Build `pausedSupporterIds` and `autoReinvestMap`.
6. Skip if paused, or if the 30-day cycle is not due.
7. `roiAmount = round(rent_amount * 0.15)`.
8. Insert `supporter_roi_payments` — unique `(rent_request_id, payment_number)` is the idempotency gate; `23505` → continue.
9. `resolveManagedProxy(supporter_id)`.
10. `create_ledger_transaction`: `roi_expense` (platform, cash_out) + `roi_wallet_credit` (wallet, cash_in, `recipient_type='user'`, `wallet_bucket='withdrawable'`).
11. `apply_roi_advance_recovery` — FIFO clawback against `recovery_source='roi'` advances.
12. Notifications (partner, plus agent when managed proxy).
13. Fire-and-forget Stage-1 "Processing" email; Stage-2 deferred to `approve-withdrawal`.
14. Update `rent_requests`: `next_roi_due_date += 30d`, `total_roi_paid`, `roi_payments_count`.
15. `logSystemEvent('roi_distributed', ...)`.
16. After the loop: inline top-up merge is **disabled**; the separate 19:00 EAT cron handles it.
17. POST manager summary to `notify-managers`; return aggregate `results` JSON.

## Appendix B — Quick Reference Card

| Question | Answer |
|---|---|
| Role name | `supporter` (Funder/Partner are UI labels) |
| Core table | `investor_portfolios` |
| Pooled ROI rate | Hardcoded flat 15% of `rent_amount`, 30-day cycles |
| PSM ROI rate | `monthly_rate` on the commitment, prorated by days live |
| True capital figure | `getContributedPrincipal()`, never `investment_amount` |
| Deposits land in | `float_balance` — always, regardless of purpose |
| Withdrawable read | `get_user_available_balance()` — `withdrawable` only |
| Sole wallet writer | `apply_wallet_movement` (5-arg overload) |
| Bucket router | `recipient_type`: `user`→withdrawable, `operational_wallet`→float, NULL→withdrawable |
| New-account withdrawal cap | 50,000 UGX/day for the first 30 days |
| Capital notice period | 90 days — column default only, not trigger-enforced |
| Requesting capital back | Pauses all ROI (`rewards_paused` defaults true) |
| Proxy withdrawal draws from | The **agent's** wallet; settled via `proxy_payout_settlements` |
| Proxy deposit commission | 1% (`wallet_transfer`) |
| Proxy investment commission | 2% (`proxy_investment_commission`) |
| Canonical ROI legs | `roi_expense` (platform, out) + `roi_wallet_credit` (wallet, in) |
| Categories that don't exist | `roi_accrued`, `partner_commission`, `portfolio_funding`, `investment_deposit`, `deposit_approved` |
