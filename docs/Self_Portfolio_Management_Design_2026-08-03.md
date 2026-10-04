# Self Portfolio Management (Support Tenants Directly)
## Senior engineering + product assessment — 2026-08-03

Status: **design assessment only. No code or schema was changed by this document.**
Author scope: read-only scan of the funder/partner flow, the ROI engine, and the wallet bucket stack.

---

## 1. Executive summary

The partner (Supporter/Funder) side of Welile today has **two disconnected capital paths**:

| Path | Who drives it | Where the money sits | How returns are paid |
|---|---|---|---|
| **A. Managed portfolio** (dominant, ~all live capital) | Staff / agent on the partner's behalf | Never in the partner's spendable wallet — it is booked into `investor_portfolios.investment_amount` | `process-supporter-roi` cron → `roi_expense` → `roi_wallet_credit` into **withdrawable** |
| **B. Direct tenant funding** (built, effectively dormant) | Partner themselves via `FundTenantsFlow` | Debits the partner's **withdrawable** wallet balance | `process-supporter-roi` on `rent_requests.supporter_id`, 15%/month |

Self Portfolio Management is really **Path B promoted to a first-class product**. The blocker the user
correctly identified is real and precise:

> Path B spends from `withdrawable`, and there is currently **nothing that stops a partner from
> withdrawing capital they have already committed to a 12-month tenant term.**

Confirmed by reading `get_withdraw_context` (the single gate used by `WithdrawFlow`): it consults
`wallet_balances_projection.withdrawable`, KYC caps, `treasury_controls.withdrawals_paused` and
pending holds — and **nothing else**. The 90-day supporter capital notice policy exists only in
`supporter-account-action` / `investment_withdrawal_requests` and is **never joined into the wallet
withdrawal gate**. So the lock the user is worried about does not exist yet, in either path.

**The good news, and the central finding of this scan:** the platform already contains a
**time-lock primitive** on the ledger that does exactly what is needed, and it is already wired
end-to-end into balances, the withdraw gate and the UI. It is currently used only for referral
bonuses (9 rows). We do **not** need a fourth wallet bucket. See §5.

---

## 2. How the partner flow is structured today

### 2.1 Frontend surface
- Route: `src/App.tsx:434` → `/dashboard/funder` → `src/pages/Dashboard.tsx` → `src/components/dashboards/SupporterDashboard.tsx`.
  Code says "supporter", UI copy says "Partner/Funder" (BOU/CMA terminology rule).
- Wallet headline: `useAvailableBalance` (strict, ledger-derived) + `UnifiedWalletHeroCard` + `FullScreenWalletSheet`.
- Portfolio surfaces: `PortfolioSummaryCards`, `MyPortfolioAccounts`, `InvestmentAccountsDrawer`, `InvestmentBreakdownSheet`.
- Returns surfaces: `ROIEarningsCard`, `InterestPaymentHistory`, `ReinvestmentHistory` (read `supporter_roi_payments`).
- Opportunity browsing: `VirtualHousesFeed`, `RentCategoryFeed`, `FunderCapitalOpportunities`, `InvestmentPackageSheet`.
- Direct funding: `src/components/payments/FundTenantsFlow.tsx` → edge fn `fund-tenants`.
- `src/components/payments/PartnerWalletWidget.tsx` is **dead code** (hardcoded demo balances, zero external imports). It should not be used as the base for the new feature.

### 2.2 Capital in (managed path)
`partner-onboarding` / `submit-portfolio-completion` → deposit verified (`deposit_requests` → `approve-deposit`)
→ `create-investor-portfolio` / `coo-create-portfolio` → `investor_portfolios` row (`status: pending_ops_approval`
→ `approve_pending_portfolio` → `active`). Mid-cycle top-ups park under ledger category
`pending_portfolio_topup` and are merged by `merge-pending-topups` / `auto-apply-pending-topups` (18:00 EAT).

`investor_portfolios` key columns: `investment_amount`, `duration_months`, `roi_percentage` (default 15),
`roi_mode` (`monthly_payout` default), `next_roi_date`, `maturity_date`, `total_roi_earned`, `auto_reinvest`,
`payout_day` (default 15), `cfo_verified*`, `pending_renewal_*`.
Note `investor_id` is nullable — proxy/agent-invested portfolios carry `agent_id` only.

### 2.3 Returns out
`supabase/functions/process-supporter-roi/index.ts`:
- ROI = `round(rent_amount * 0.15)` per funded `rent_requests` row (hardcoded 15%; the projection helper
  `src/lib/funderEarnings.ts` independently implements the same 15%/month).
- Due-date gate: `rent_requests.next_roi_due_date`, else `funded_at + 30 days`.
- Idempotency: unique `(rent_request_id, payment_number)` on `supporter_roi_payments`; `23505` = already paid.
- Payout branches:
  - `auto_reinvest` → `roi_expense` (platform, cash_out) ⇄ `roi_reinvestment` (platform, cash_in) + `investment_amount += roi`.
  - default → `roi_expense` (platform) ⇄ `roi_wallet_credit` (wallet, `recipient_type:'user'`, `wallet_bucket:'withdrawable'`), then `apply_roi_advance_recovery`.
- Managed-proxy partners: credit still lands in the partner's own wallet; the proxy agent withdraws.
- CFO manual equivalent: `cfo-direct-credit` (posts the same `roi_expense`/`roi_wallet_credit` pair, bypassing due-date/idempotency — role + category allowlist are the only guards).

**Product implication for the new feature:** ROI logic is already keyed on `rent_requests.supporter_id`,
not on `investor_portfolios`. That is exactly the shape Self Portfolio Management needs — **the returns
engine requires no change.** The gap is purely on the capital-commitment side.

---

## 3. Direct tenant funding as it exists (Path B)

`FundTenantsFlow.tsx`: mode (`specific` / `location` / `auto`) → select tenants → amount
(`full` / `partial` 50% / `daily` prorated by `funding_days/30`) → confirm → `fund-tenants`.

`supabase/functions/fund-tenants/index.ts`:
- Requires the `supporter` role.
- Checks `wallets.balance >= totalFunding` — **reads the cached view, not the strict RPC. This is a defect** (memory rule: `get_user_available_balance` / `v_user_wallet_strict` is the only legitimate gate).
- Per rent request: `status='funded'`, `funded_at`, `supporter_id = user.id`; creates `subscription_charges`; notifies the tenant.
- Money movement is **queued** into `pending_wallet_operations` (category "rent facilitation payout", supporter `cash_out` ⇄ landlord `cash_in`) awaiting manager approval — it is not instantly ledger-posted.

Linkage facts:
- `rent_requests.supporter_id` is the **only** link from a tenant to a funder. There is **no `portfolio_id` on `rent_requests`.**
- `supporter_roi_payments.rent_request_id` and `supporter_capital_ledger.rent_request_id` are the per-request return/capital trails.

---

## 4. The bucket architecture, precisely

`wallets` is **a view**, not a table:
`wallets_physical` ⋈ `wallet_balances_projection` (with INSTEAD-OF triggers so legacy writes don't break).

Truth is recomputed by **`refresh_wallet_projection_for(user_id)`**, which:
1. Reads `general_ledger` rows with `ledger_scope='wallet'`, production-classified, after any `wallet_fresh_start_anchors.anchor_at`.
2. Buckets each row either by the **explicit** `general_ledger.wallet_bucket` (`withdrawable` | `float` | `advance_credit` | `advance_repayment`) or, when null, by **`wallet_route_for_category(user_id, category, direction)`**.
3. Computes `restricted_held` = sum of **withdrawable credits that have not matured** — see §5.
4. Computes `pending_holds` from open `withdrawal_requests` with no offsetting ledger leg.
5. **`withdrawable = GREATEST(0, withdrawable_raw − restricted_held − pending_holds)`**.
6. Upserts the projection row.

Routing:
- `wallet_route_for_category(text,text)` — immutable, category→bucket (`agent_float_*`→`float`, advance categories→advance, else `withdrawable`).
- `wallet_route_for_category(uuid,text,text)` — agent-aware overrides (forces `partner_funding`, `supporter_capital`, `supporter_rent_fund`, `cfo_direct_credit`, `pool_capital_received`, `manager_credit` to `float` when the user holds the enabled `agent` role). ROI categories are deliberately excluded (see `mem/architecture/roi-always-withdrawable.md`).
- `trg_set_wallet_bucket_from_recipient_type` — BEFORE INSERT fallback stamp: `user`→`withdrawable`, `operational_wallet`→`float`.

Agent float is the precedent for a non-withdrawable bucket: `agent_float_limits`, `agent_float_funding`,
`agent_landlord_float*`, categories `agent_float_deposit|assignment|topup|used_for_rent|settlement`.
UI separates it (`FloatBreakdownCard.tsx`, `AgentWalletHeroCard.tsx`) and `useWithdrawContext.checkAmount`
compares only against `withdrawable`, so float is structurally unwithdrawable.

Withdrawal gate: `get_withdraw_context(user_id)` → `get_user_wallet_view` (projection) + `get_kyc_effective_limits`
+ today's `withdrawal_requests` usage + `treasury_controls.withdrawals_paused`.
KYC caps (live values): **L1 = 50,000/day, 1 txn; L2 = 500,000/day, 10 txn; L3 ≈ 1e9/day.**

---

## 5. Key finding — the lock primitive already exists

`general_ledger` carries three columns already consumed by `refresh_wallet_projection_for`:

- `withdrawable_after timestamptz` — the moment the credit becomes withdrawable
- `maturity_met boolean`
- `maturity_expired boolean`

Projection logic (verbatim intent): a `withdrawable` **credit** counts into `restricted_held` — i.e. is
subtracted from the spendable figure — when `maturity_expired = true` **or** (`maturity_met = false`
**and** `now() <= withdrawable_after`).

It is already surfaced all the way to the user:
`refresh_wallet_projection_for` → `wallet_balances_projection.restricted_held` → `get_user_wallet_view`
→ `get_withdraw_context` → `useWithdrawContext.wallet.restrictedHeld` → `useAvailableBalance` →
`WithdrawRequestDialog.tsx:696` ("X held from bonus earnings").

Current usage: **9 rows total, all `referral_bonus`** (3-day locks). Zero partner usage.

### 5.1 Consequence: bucket vs. maturity — recommendation

Adding a fourth bucket (`committed_balance`) is possible but expensive. It would require changes to:
`wallet_balances_projection` (schema + `refresh_wallet_projection_for` sums), the `wallets` view,
`v_user_wallet_strict`, both `wallet_route_for_category` overloads, `set_wallet_bucket_from_recipient_type`,
`ledger_category_allowlist` / `validate_ledger_category`, `assert_routing_compatible`,
`get_user_wallet_view`, `get_withdraw_context`, `get_user_available_balance`, plus
`useWallet`, `useWalletBalance`, `useAvailableBalance`, `useWithdrawContext`, `UnifiedWalletHeroCard`,
`WalletDetailsSheet`, `FloatBreakdownCard`, `PortfolioSummaryCards`, `UserWalletStatementsPanel`,
`ManagerBankingLedger`, `MoneySourcesBreakdown`, `PlatformCashBreakdown`, `useFinancialStatements`,
`financialStatementsDrillMap`, and the bucket-transfer edge fns (`admin-float-to-withdrawable`,
`admin-withdrawable-to-float`, `finops-wallet-move`, `transfer-to-float`).
**Every one of those enumerates the three buckets literally and would silently omit a new one.**

**Recommendation: do NOT add a fourth bucket. Use the maturity primitive.**

| Dimension | New `committed` bucket | Maturity lock on withdrawable legs |
|---|---|---|
| DB objects touched | ~12 functions/views + allowlists | 0 (already implemented) |
| UI files touched | ~15, else silent money disappearance | 1–2 (label copy) |
| Reconciliation risk | High — new bucket invisible to every drift detector, pivot view and CFO panel | None — `restricted_held` is already in the pivot and in `v_user_wallet_strict` |
| Per-tenant granularity | No — a single scalar | **Yes** — lock is per ledger leg, so per rent request / per 12-month term |
| Auto-release at term end | Needs a cron to move bucket→bucket | Free: `now() > withdrawable_after` releases automatically |
| Matches the product rule ("must stay 12 months") | Approximately | Exactly |

Per-leg granularity is decisive. A partner supporting five tenants on five different start dates needs
five independent 12-month clocks. A scalar bucket cannot express that; `withdrawable_after` per leg can.

### 5.2 Two capital sources, one mechanism

The user's instinct ("this may or might be got from the withdrawable… but they must use it for a year")
resolves cleanly:

- **Fresh deposit → direct support.** Deposit posts a normal withdrawable credit; the support debit
  immediately consumes it. Nothing to lock; the capital is already out of the wallet and inside a
  `rent_requests` term. Locking applies to the **return of principal**, not the deposit.
- **Existing withdrawable → direct support.** Same debit. Again the principal leaves the wallet.

So the honest framing is: **there is nothing to "hold read-only" while the money is deployed — it is
deployed.** What must be locked is the *principal repayment leg* when it comes back mid-term, and the
*commitment* must be visible so the partner understands their withdrawable dropped for a 12-month reason.
That is a **statement/exposure** problem, not a bucket problem:

1. Debit withdrawable at support time (existing `fund-tenants` behaviour, but via the strict gate).
2. Any principal that returns to the wallet before `term_end` is posted with
   `withdrawable_after = term_end`, `maturity_met = false` → lands in `restricted_held`, invisible to
   the withdraw gate, auto-released at term end.
3. Show "Committed capital (locked until <date>)" as a **derived** figure from the partner's own
   `rent_requests` rows — not a wallet bucket.

### 5.3 Where the existing 90-day notice fits

`investment_withdrawal_requests` (from `supporter-account-action`, `earliest_process_date = now()+90d`,
`rewards_paused=true`) is currently **unenforced at the wallet layer**. Once maturity locking is in use
for partners, the 90-day capital-exit notice should be expressed the same way (a maturity-dated principal
leg), which closes a real compliance gap independent of this feature.

---

## 6. Product definition — Self Portfolio Management

### 6.1 One-line
A partner picks specific tenants/houses themselves, commits their own capital for a 12-month term, and
earns 15%/month on that capital — with the commitment and its unlock date shown honestly in the wallet.

### 6.2 Why it matters
- **Partner:** agency and transparency. Today they hand money to ops and wait; here they choose the house, see the tenant, and watch their own book.
- **Welile:** removes staff from the capital-deployment critical path (`create-investor-portfolio`, `approve_pending_portfolio`, COO/CFO queues), which is the current throughput ceiling on partner capital.
- **Tenant:** faster funding — self-serve partners can fund outside ops hours.

### 6.3 Scope boundary (explicit non-goals)
- Does **not** replace managed `investor_portfolios`. Both coexist; the dashboard shows two books.
- Does **not** change the ROI rate, the ROI engine, or `supporter_roi_payments`.
- Does **not** introduce a new wallet bucket (per §5.1).
- Does **not** touch agent float.

### 6.4 Rules to lock before build
| Rule | Proposed | Needs sign-off |
|---|---|---|
| Term | 12 months from `funded_at` per tenant | yes |
| Return | 15%/month of the funded rent amount (parity with `process-supporter-roi`) | yes |
| Minimum ticket | 1 full month's rent for one house | yes |
| Early exit | none before term end; principal returns are maturity-locked to `term_end` | yes |
| Tenant default | who absorbs it — Welile guarantee, or partner risk? **Currently undefined for Path B and is the single largest open risk.** | **yes, blocking** |
| Approval | self-serve, or ops review of the first commitment per partner? | yes |
| KYC gate | direct support should require ≥ L2 (L1's 50K/day cap implies a very thin account) | yes |

---

## 7. Proposed technical shape (for approval, not yet built)

### 7.1 Data
- New table `partner_direct_commitments`: `partner_id`, `rent_request_id`, `amount`, `term_months` (12), `funded_at`, `term_end_at`, `expected_monthly_return`, `status` (`active|matured|defaulted|exited`), `created_at`, `updated_at`. GRANTs + RLS (partner reads own; ops read all; service_role all).
  Rationale: `rent_requests.supporter_id` alone cannot express term/commitment metadata, and adding a `portfolio_id` to `rent_requests` would entangle it with the managed path.
- No change to `general_ledger`, `wallets*`, or any bucket. Only *usage* of `withdrawable_after` / `maturity_met` on principal-return legs.

### 7.2 Server
- New RPC/edge fn `partner-commit-capital` (or harden `fund-tenants`):
  - gate on `get_user_available_balance` / `get_withdraw_context` — **never `wallets.balance`** (fixes the current defect);
  - post the debit leg through `create_ledger_transaction` with an allowlisted category (candidate: reuse `supporter_rent_fund` / `partner_funding`; adding a category means updating `ledger_category_allowlist`);
  - set `rent_requests.supporter_id`, `funded_at`, `status='funded'`;
  - insert `partner_direct_commitments`;
  - emit a `system_events` row and a trust-score signal via `capture_trust_signal` (constitution requirement).
- Principal-return path: stamp `withdrawable_after = term_end_at`, `maturity_met = false`.

### 7.3 Client
- New `src/components/supporter/SelfPortfolioSheet.tsx` (pick house → confirm term/returns → commit), reusing `funderEarnings.ts` for the projection so displayed and paid returns cannot diverge.
- New `MyDirectSupportCard` on `SupporterDashboard`: committed capital, unlock dates, per-tenant returns.
- Wallet copy: `restrictedHeld` label in `WithdrawRequestDialog.tsx:696` currently says "held from bonus earnings" — must become source-aware.

### 7.4 Suggested phasing
1. **Phase 0 (hardening, ship first):** point `fund-tenants` at the strict balance gate; make the `restrictedHeld` label source-aware. Low risk, fixes a real gate hole.
2. **Phase 1:** `partner_direct_commitments` + commit RPC + confirmation UI, ops-reviewed, whitelist of pilot partners.
3. **Phase 2:** maturity-locked principal returns + partner-facing commitment book + statements.
4. **Phase 3:** self-serve at scale, KYC gating, defaults policy enforcement, CFO exposure panel.

---

## 8. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Default liability for direct-funded tenants undefined | **High** | Blocking product decision before Phase 1 |
| `fund-tenants` gates on the cached `wallets.balance` | High | Phase 0 |
| Partner commits, then cannot withdraw, and did not understand the term | High | Explicit term confirmation copy + unlock date on the wallet card |
| Adding a 4th bucket would silently break ~15 UI readers and every drift detector | High | Rejected in favour of the maturity primitive |
| Two capital books (managed + direct) confusing in the UI and in CFO reporting | Medium | Distinct cards, distinct ledger source_table, distinct CFO section |
| 90-day notice still unenforced at the wallet layer | Medium | Fold into the same maturity mechanism |
| `restricted_held` is currently near-unused (9 rows) — low production confidence | Medium | Phase 2 pilot with small amounts; reconcile via `v_user_wallet_strict` |

---

## 9. Decisions required from product

1. Who absorbs a default on a directly-funded tenant?
2. Self-serve from day one, or ops-reviewed first commitment?
3. Minimum ticket and minimum KYC level?
4. Does direct support earn the same 15%/month, or a different rate (partner does the selection work)?
5. Is early exit ever permitted, and at what penalty?

---

### Appendix — verified facts and their sources
- `/dashboard/funder` route: `src/App.tsx:434`; dashboard: `src/components/dashboards/SupporterDashboard.tsx`.
- Dead component: `src/components/payments/PartnerWalletWidget.tsx` (no external imports).
- ROI engine: `supabase/functions/process-supporter-roi/index.ts` (15% at l.159; idempotency l.171-186; reinvest l.190-280; wallet credit l.281-330).
- Direct funding: `src/components/payments/FundTenantsFlow.tsx` (edge call l.176); `supabase/functions/fund-tenants/index.ts`.
- Projection/lock logic: `refresh_wallet_projection_for` — `restricted_held` computation and `withdrawable = GREATEST(0, raw − restricted_held − pending_holds)`.
- Withdraw gate: `get_withdraw_context` — confirmed **not** to consult `investment_withdrawal_requests`.
- KYC caps live: `kyc_level_config` → L1 50,000 / 1; L2 500,000 / 10; L3 ~1e9 / 999.
- Maturity usage today: 9 `general_ledger` wallet legs with `withdrawable_after`, all `referral_bonus`; 0 expired.
- 90-day notice: `supabase/functions/supporter-account-action/index.ts` (`withdraw_capital`, l.115-165) → `investment_withdrawal_requests`.
- No `portfolio_id` column on `rent_requests`; `supporter_id` is the sole funder link.