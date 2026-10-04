# Welile — Financial System Architecture Reference Manual

**Status:** Authoritative technical reference
**Generated:** 2026-08-04
**Scope:** Every path through which value enters, moves inside, or leaves the platform.
**Base currency:** UGX (ISO 4217). All amounts in this document are UGX unless stated.

> **Evidence rule used throughout.** Every structural claim in this manual was verified
> against the **live database** (`pg_proc`, `pg_trigger`, `information_schema`,
> `cron_jobs_health()`, `pg_get_viewdef`) and/or the checked-in source in
> `supabase/functions/**` and `src/**` at the timestamp above. Where the live database and the
> checked-in migration history disagree, **the live database is treated as truth** and the
> divergence is recorded in Section 16.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Money flow map](#2-money-flow-map)
3. [Ledger architecture](#3-ledger-architecture)
4. [Wallet architecture](#4-wallet-architecture)
5. [Inbound value channels](#5-inbound-value-channels)
6. [Outbound value channels](#6-outbound-value-channels)
7. [Credit and liability inventories](#7-credit-and-liability-inventories)
8. [Revenue recognition](#8-revenue-recognition)
9. [Commissions, bonuses and incentives](#9-commissions-bonuses-and-incentives)
10. [Supporter and partner capital](#10-supporter-and-partner-capital)
11. [Automation and scheduling](#11-automation-and-scheduling)
12. [Reconciliation and drift control](#12-reconciliation-and-drift-control)
13. [Anomaly detection and alerting](#13-anomaly-detection-and-alerting)
14. [Controls, authorisation and security](#14-controls-authorisation-and-security)
15. [Reporting surfaces](#15-reporting-surfaces)
16. [Known gaps and risk register](#16-known-gaps-and-risk-register)
17. [Appendices](#17-appendices)

---

## 1. Executive summary

### 1.1 Object census (live, verified)

| Object | Count |
| --- | --- |
| Public tables | 452 (452 with RLS enabled — 100%) |
| RLS policies | 1,189 |
| Public functions (RPC + trigger fns) | 1,074 |
| Non-internal triggers | 415 |
| Triggers on `general_ledger` alone | 34 |
| Edge Functions | 285 |
| Checked-in migrations | 2,019 |
| `general_ledger` rows | 372,273 |

### 1.2 The five invariants the system is built on

1. **Double-entry ledger is the sole source of truth.** `general_ledger` is append-only.
   Balances are *derived*, never authored.
2. **One authorised writer.** Rows may only enter `general_ledger` through the
   `create_ledger_transaction` RPC, which sets a transaction-local session flag
   (`ledger.authorized = true`). A `BEFORE INSERT` guard rejects everything else.
3. **Every group nets to zero.** All legs sharing a `transaction_group_id` must sum to zero
   (`cash_in`/`credit` positive, `cash_out`/`debit` negative).
4. **Wallets are a projection.** `wallets` is a **view**; the materialised cache is
   `wallet_balances_projection`, refreshed from the ledger by in-transaction triggers and
   reconciled on a schedule. No business code writes a balance.
5. **`recipient_type` routes money, roles do not.** `user` → `withdrawable` bucket;
   `operational_wallet` → `float` bucket. Categories drive *accounting classification only*.

### 1.3 Ledger volume by scope (live)

| `ledger_scope` | Rows | First | Last | Net (cash_in − cash_out) |
| --- | --- | --- | --- | --- |
| `wallet` | 187,192 | 2026-02-11 | 2026-08-04 | 2,628,791,058.50 |
| `platform` | 174,426 | 2026-02-20 | 2026-08-04 | 378,831,402.50 |
| `bridge` | 10,655 | 2026-02-11 | 2026-08-04 | 783,642,062 |

Scope semantics:

- **`wallet`** — legs that affect a user-visible balance bucket. Requires a `user_id`
  (`zz_enforce_wallet_scope_requires_user`).
- **`platform`** — the company side of every transaction: revenue, expense, treasury.
- **`bridge`** — non-cash obligations and facilitation records (chiefly
  `rent_receivable_created`, 8,232 rows / 728,147,713) that must not inflate wallets.

### 1.4 Classification partitions (live)

| `classification` | Rows | Meaning |
| --- | --- | --- |
| `production` | 360,269 | Real, reportable economic activity |
| `admin_correction` | 8,531 | Operator corrections; excluded from user-facing statements |
| `legacy_real` | 2,797 | Pre-cutover real money, retained for history |
| `test_dev` | 676 | Non-economic test residue |

`trg_enforce_production_april_cutoff` forces `classification = 'production'` on any row dated
`>= 2026-04-01`; only `admin_correction` may differ. This makes the April 2026 boundary a hard
reporting cutover.

---

## 2. Money flow map

### 2.1 Top-level flow

```text
                        +----------------------------------------------+
   EXTERNAL WORLD       |              WELILE PLATFORM                 |      EXTERNAL WORLD
                        |                                              |
 MoMo / USSD ------+    |   +-----------------------------------+       |   +-- Mobile money payout
 Bank transfer ----+    |   |        deposit_requests           |       |   +-- Bank transfer
 Cash + receipt ---+--->|   |  (single intake table, all lanes) |       |   +-- Cash via merchant
 Agent cash PIN ---+    |   +----------------+------------------+       |   +-- Landlord rent
 Gmail-matched ----+    |        approve-deposit (sole approver)        |   +-- Payroll / requisition
 Field batches ----+    |                    |                         |   +-- Supporter ROI / capital
                        |                    v                         |            ^
                        |      create_ledger_transaction  <------------+------------+
                        |        (the ONLY ledger writer)              |   approve-withdrawal
                        |                    |                         |   (sole outflow poster)
                        |                    v                         |
                        |   +-----------------------------------+      |
                        |   |  general_ledger  (append-only)    |      |
                        |   |  scope: wallet | platform | bridge|      |
                        |   +----------------+------------------+      |
                        |        in-transaction projection triggers    |
                        |                    v                         |
                        |   wallet_balances_projection --> wallets     |
                        |              (view: what users see)          |
                        +----------------------------------------------+
```

### 2.2 Canonical leg pattern

Every economic event posts **at least two legs** in one `transaction_group_id`:

| Event | Wallet leg | Platform leg |
| --- | --- | --- |
| Deposit approved | `agent_float_deposit` · `cash_in` · `recipient_type=operational_wallet` · bucket `float` | `agent_float_deposit` · `cash_out` |
| Commission earned | `agent_commission_earned` · `cash_in` · `recipient_type=user` · bucket `withdrawable` | `agent_commission_earned` · `cash_out` |
| Withdrawal paid | `wallet_withdrawal` · `cash_out` · bucket `withdrawable` | `wallet_withdrawal` · `cash_in` |
| Advance issued | `agent_advance_credit` · `cash_in` · `recipient_type=user` | `agent_advance_credit` · `cash_out` |
| Advance recovered | `agent_repayment` · `cash_out` · `recipient_type=user` | `agent_repayment` · `cash_in` · `recipient_type=operational_wallet` |
| Rent disbursed | `rent_disbursement` · `cash_out` | `landlord_rent_payment` · `cash_in` |
| Rent obligation created | — | `rent_receivable_created` (scope `bridge`) |
| Salary released | `salary_payout` · `cash_in` | `salary_payout` · `cash_out` |

### 2.3 Verified production volumes by category

**Wallet scope — top flows (production only):**

| Category | Rows | Amount |
| --- | --- | --- |
| `wallet_deposit` | 1,377 | 2,979,136,653 |
| `partner_funding` | 1,139 | 2,889,126,243 |
| `roi_wallet_credit` | 1,573 | 1,694,280,035 |
| `wallet_withdrawal` | 6,361 | 1,632,778,100 |
| `agent_float_deposit` | 2,954 | 1,456,295,559 |
| `wallet_transfer` | 1,964 | 1,232,752,450 |
| `historical_balance_reseed` | 552 | 1,066,674,735 |
| `agent_commission_earned` | 39,140 | 953,122,287 |
| `wallet_deduction` | 309 | 942,517,431 |
| `wallet_deduction_general_adjustment` | 48 | 778,896,386 |
| `agent_float_settlement` | 6,276 | 742,888,118 |
| `roi_payout` | 103 | 307,658,729 |
| `agent_float_assignment` | 189 | 235,699,277 |
| `rent_payment_for_tenant` | 6,072 | 146,284,833 |
| `agent_commission` | 57,651 | 115,957,758 |
| `agent_advance_credit` | 215 | 24,788,011 |
| `referral_bonus` | 47,562 | 18,484,000 |

**Platform scope — top flows (production only):**

| Category | Rows | Amount |
| --- | --- | --- |
| `partner_funding` | 1,194 | 5,772,016,754 |
| `pending_portfolio_topup` | 1,511 | 3,426,373,904 |
| `roi_expense` | 2,142 | 2,255,106,800 |
| `wallet_withdrawal` | 5,238 | 1,641,312,980 |
| `wallet_deposit` | 566 | 1,580,357,526 |
| `agent_float_deposit` | 2,926 | 1,443,414,459 |
| `general_admin_expense` | 563 | 1,147,164,039 |
| `agent_commission_earned` | 30,582 | 931,266,308 |
| `platform_loss_writeoff` | 478 | 465,473,700 |
| `marketing_expense` | 102,187 | 155,747,196 |
| `payroll_expense` | 111 | 62,066,999 |
| `registration_fee_collected` | 259 | 2,900,000 |

**Bridge scope (all classifications):**

| Category | Rows | Amount |
| --- | --- | --- |
| `rent_receivable_created` | 8,232 | 728,147,713 |
| `supporter_facilitation_capital` | 47 | 61,866,541 |
| `partner_funding` | 9 | 53,461,603 |
| `system_balance_correction` | 4 | 20,144,110 |
| `agent_commission` | 2,363 | 1,766,095 |

---

## 3. Ledger architecture

### 3.1 `create_ledger_transaction` — the only door

Behaviour verified from the live function body:

1. **Type gate.** `entries` must be a JSON *array*. A stringified array is rejected outright
   (`entries must be a JSON array, got: string`).
2. **Authorisation.** `PERFORM set_config('ledger.authorized','true', true)` — transaction-local,
   so authorisation cannot leak across statements or sessions.
3. **Idempotency.** When `idempotency_key` is supplied it takes
   `pg_advisory_xact_lock(abs(hashtext(key)))`, then returns the *existing*
   `transaction_group_id` if one already exists. Replays are therefore safe and silent.
4. **Positive amounts only.** `amount <= 0` raises.
5. **Recovery isolation.** For wallet-scope legs in
   `agent_repayment`, `agent_advance_repayment`, `salary_advance_repayment`, `debt_recovery`,
   an explicit `recipient_type` is **mandatory**; a missing value logs to
   `wallet_routing_violations` and raises `RECIPIENT_TYPE_REQUIRED`. This is what stops debt
   recovery from silently eating float or custody money.
6. **Routing compatibility.** `assert_routing_compatible(category, recipient_type)` must pass.
7. **Group assembly.** A single `transaction_group_id` is minted for the whole array.

### 3.2 The 34 `general_ledger` triggers, grouped by purpose

**Authorisation / immutability**

| Trigger | Function | Effect |
| --- | --- | --- |
| `trg_guard_ledger_write` | `guard_ledger_write` | Rejects inserts without `ledger.authorized` |
| `trg_enforce_ledger_rpc_only` | `enforce_ledger_rpc_only` | Blocks non-RPC insert paths |
| `trg_prevent_ledger_update` / `trg_prevent_ledger_delete` | `prevent_ledger_mutation` | Ledger is append-only |

**Balance and classification integrity**

| Trigger | Function |
| --- | --- |
| `trg_enforce_ledger_group_balance` | `enforce_ledger_group_balance` |
| `trg_enforce_correction_classification` | `enforce_correction_classification` |
| `trg_enforce_production_april_cutoff` | `enforce_production_classification_april_cutoff` |
| `trg_validate_ledger_category` | `validate_ledger_category` |
| `trg_auto_ledger_scope` | `auto_assign_ledger_scope` |

**Routing**

| Trigger | Function | Effect |
| --- | --- | --- |
| `trg_set_wallet_bucket_from_recipient_type` | `set_wallet_bucket_from_recipient_type` | Stamps `wallet_bucket` from `recipient_type` when null |
| `trg_assert_wallet_routing` | `assert_wallet_routing` | Rejects unroutable wallet legs (`WALLET_ROUTING_REQUIRED`) |
| `general_ledger_route_buckets` | `tr_general_ledger_route_buckets` | Bucket derivation fallback |
| `zz_enforce_wallet_scope_requires_user` | `enforce_wallet_scope_requires_user` | Wallet scope must name a user |
| `trg_enforce_managed_proxy_roi_routing` | `enforce_managed_proxy_roi_routing` | Managed-proxy ROI lands in the proxy wallet |

**Solvency and abuse prevention**

| Trigger | Function |
| --- | --- |
| `trg_enforce_no_negative_wallet_ledger` | `enforce_no_negative_wallet_ledger` |
| `trg_block_legacy_wallet_deduction` | `block_legacy_wallet_deduction` |
| `trg_block_merchant_agent_auto_debit` | `enforce_no_merchant_agent_auto_debit` |
| `trg_block_proxy_custody_writes` | `block_proxy_custody_writes` |
| `trg_block_retired_instant_house_reward` | `block_retired_instant_house_reward` |
| `trg_enforce_no_fraud_wallet_earnings` | `enforce_no_fraud_wallet_earnings` |
| `trg_enforce_single_rent_disbursement` | `enforce_single_rent_disbursement` |
| `trg_enforce_tid_deposit_uniqueness` | `enforce_tid_deposit_uniqueness` |
| `trg_verify_advance_disbursement` | `verify_advance_disbursement_matches_principal` |

**Projection and derived state**

| Trigger | Function |
| --- | --- |
| `trg_wallet_projection_ledger` | `tg_refresh_wallet_projection_on_ledger` |
| `trg_wallet_projection_maturity` | `tg_refresh_wallet_projection_on_maturity` |
| `trg_ledger_pivot_apply` | `tg_ledger_pivot_apply` |
| `trg_ledger_running_balance` | `compute_ledger_running_balance` |
| `trg_sync_wallet_from_ledger` | `sync_wallet_from_ledger` (permanent no-op, retained for compatibility) |

**Side effects**

| Trigger | Function |
| --- | --- |
| `trg_recover_advance_arrears_on_earning` | `tg_recover_advance_arrears_on_earning` |
| `trg_apply_bonus_restriction` | `trg_apply_bonus_restriction_fn` |
| `trg_notify_agent_commission_paid` | `notify_agent_commission_paid` |
| `trg_ensure_depositor_profile_on_credit` | `trg_ensure_depositor_profile` |
| `trg_general_ledger_supporter_capital` | `trg_auto_log_supporter_capital` |
| `trg_log_ledger_wallet_transfer` | `log_ledger_wallet_transfer_event` |

### 3.3 Group balance enforcement, exactly as implemented

`enforce_ledger_group_balance()`:

- Skips rows with a null `transaction_group_id`.
- Reads the enforcement start date from `ledger_integrity_config.enforce_from`; groups whose
  earliest leg predates it are grandfathered.
- **Correction groups** (any leg with `category = 'system_balance_correction'`) may mix
  `production` and `admin_correction` — nothing else — and must still net to zero across both.
- **Non-correction groups** may not mix `production` with `admin_correction` at all.
- For `production` rows, `SUM(cash_in/credit − cash_out/debit)` over the group must be `0`,
  otherwise: `Ledger group % is unbalanced (net=%)`.

### 3.4 Category allow-list

`ledger_category_allowlist()` returns a fixed array (~110 entries) enforced by
`trg_validate_ledger_category`. **An invented category fails the write.** The full list is in
Appendix A.

---

## 4. Wallet architecture

### 4.1 Current physical model (this superseded the older cache model)

| Object | Kind | Role |
| --- | --- | --- |
| `wallets` | **view** | Compatibility surface the app reads |
| `wallets_physical` | table | Wallet identity rows only (no balances of record) |
| `wallet_balances_projection` | table | The materialised balance projection (`withdrawable`, `float_balance`, `advance_balance`, `pending_holds`, `restricted_held`, `total_visible`, `ledger_version`, `updated_at`) |
| `v_user_wallet_strict` | view | The ledger-truth pivot every balance is measured against |
| `ledger_balance_pivot` | table | Pivot cache used by the 10-minute batch reconciler |

`apply_wallet_movement` — historically the sole bucket writer — is now **neutered by design**.
Its live body only (a) resolves the route for diagnostics, (b) records unrouted categories in
`wallet_unrouted_movements`, and (c) ensures a `wallets_physical` identity row exists. Its own
comment states: *"No bucket writes — ledger is truth."* The v2 overload additionally *requires*
`recipient_type` in (`user`, `operational_wallet`), logging `RECIPIENT_TYPE_REQUIRED` to
`wallet_routing_violations` and raising otherwise.

### 4.2 The three buckets

| Bucket | Meaning | Withdrawable? |
| --- | --- | --- |
| `withdrawable` | The user's own money: commissions, ROI, salary, approved credit | Yes |
| `float` | Company money entrusted to an agent for field operations | **Never** |
| `advance_balance` | Outstanding liability owed back to the company | N/A (reduces future earnings) |

### 4.3 How withdrawable is actually computed

`v_user_wallet_strict` (verified definition):

1. **Anchor filter.** `wallet_fresh_start_anchors` lets an account be re-based; only legs at or
   after `anchor_at` count.
2. **Eligibility filter.** Only `ledger_scope = 'wallet'` legs where
   `classification IS NULL OR 'production'`, plus the narrow exception of
   `admin_correction` + `system_balance_correction` + `debit/cash_out` (corrections may only ever
   *reduce* a balance).
3. **Reversal exclusions.** Legs from `commission_engine` whose
   `commission_accrual_ledger` row is `reversed` (event `rent_funded_landlord_float`) are removed,
   as is the matching 10,000 reversal artefact.
4. **Routing.** Legs with an explicit `wallet_bucket` are used as-is; legs without one are routed
   through `wallet_route_for_category(user_id, category, direction)`.
5. **Signing.** `cash_in`/`credit` = +1, `cash_out`/`debit` = −1.
6. **Bucket sums** produce `withdrawable_raw`, `float_raw`, `advance_raw`, plus `restricted_held`
   (immature, unexpired credits).
7. **Pending holds.** Sum of `withdrawal_requests` in
   `pending, requested, manager_approved, processing, approved` that have **no** corresponding
   wallet debit yet. Proxy rows (`proxy_partner_id` + `agent_id`) are held against the **agent**.
8. **Final:**

```text
withdrawable    = GREATEST(0, withdrawable_raw - restricted_held - pending_holds)
float_balance   = GREATEST(0, float_raw)
advance_balance = GREATEST(0, advance_raw)
total_visible   = withdrawable + float_balance
```

`get_user_available_balance(p_user_id)` now simply reads
`wallet_balances_projection.withdrawable`, which is kept equal to the strict view by the
in-transaction triggers plus the reconcilers in Section 12. A single number therefore serves the
wallet UI, `WithdrawFlow`, and the `approve-withdrawal` gate.

### 4.4 Diagnostic side-channels

| Table | Written when |
| --- | --- |
| `wallet_routing_violations` | `recipient_type` missing or incompatible with category |
| `wallet_unrouted_movements` | A category resolves to bucket `none` / sign `0` |
| `wallet_overdraw_events` | An attempted debit exceeded the strict balance |
| `wallet_projection_drift_alerts` | Projection diverged from `v_user_wallet_strict` |

---

## 5. Inbound value channels

### 5.1 The convergence rule

Every inbound lane converges on **one intake table** (`deposit_requests`) and **one approver**
(`supabase/functions/approve-deposit/index.ts`). Nothing credits a wallet by any other route.

Observed live status distribution on `deposit_requests`:
`approved` 2,973 · `rejected` 207 · `pending` 56 · `failed` 11 · `reversed` 6.

### 5.2 Channel inventory

| Channel | Entry point | Notes |
| --- | --- | --- |
| Mobile money (MoMo TID self-report) | client insert → `approve-deposit` | TID uniqueness enforced by `trg_enforce_tid_deposit_uniqueness` and `validate-deposit-reference` |
| USSD (feature phones) | `ussd-callback` | Africa's Talking callback with token check |
| Cash + receipt code | `cash-deposit-request-code` → `cash-deposit-verify-code` | Code readback; auto-credits through `approve-deposit` with `system_auto_credit` |
| Agent-witnessed cash (PIN) | `agent-cash-deposit-create` → `agent-cash-deposit-confirm` (+ `-resend`) | Debits agent float, credits depositor withdrawable; sessions in `agent_cash_deposit_sessions`, expiry cron `expire-cash-deposit-codes` (every minute) |
| Bank transfer / treasury top-up | `agent-deposit`, `record-bank-float-transfer` | Operational float funding |
| Email-matched (Gmail) | `gmail-poll-transactions` + `auto_match_email_deposits` + `auto_create_deposits_from_gmail_impl` | See 5.5 |
| Field agent batches | client → `verify-field-deposit` → `process_verified_field_deposit` | See 5.6 |
| Angel pool / share capital | `angel-pool-invest`, `agent-angel-pool-invest` | `angel_pool_investments`, category `angel_pool_investment` (46 rows / 85,965,000) |
| Reversal lane | `reverse-uncoded-deposits` | Produces balanced reversal groups only |

### 5.3 `approve-deposit` control sequence

1. **Auth.** Staff JWT, or a service-role call carrying `system_auto_credit: true` (used by the
   Gmail poller and the cash-code verifier) which impersonates the deposit owner.
2. **Rejection discipline.** A rejection requires a `rejection_reason` of at least 10 characters,
   enforced server-side.
3. **Idempotency.** Before crediting, the function looks for an existing wallet `cash_in` leg with
   `source_table='deposit_requests'` and `source_id=<id>`. This guard exists because of a real
   triple-credit incident (2026-04-27) and is the reason repeated approvals are now inert.
4. **Routing (Float-by-Default, 2026-07-28/29).** Approved deposits are forced to
   `isFloatDeposit = true`; `deposit_purpose` survives for analytics only. Category
   `agent_float_deposit`, `recipient_type = operational_wallet`, bucket `float`.
5. **Ledger post.** Balanced pair via `create_ledger_transaction` (wallet `cash_in` +
   platform `cash_out`).
6. **Status flip after the ledger write**, never before — this is what prevents
   "approved but uncredited" phantom rows.
7. **Post-steps.** `apply_wallet_movement` is still called for its diagnostic/identity role;
   failures are recorded to `audit_logs` and `system_events` (`wallet.writer_failed`) without
   rolling back the ledger. A bounded `withRetry` helper (3 attempts, linear backoff) wraps
   transient sub-steps, deliberately **not** the initial credit.
8. **Reopen.** `rejected → pending` is a manager-only transition.

### 5.4 The deposit bridge (independent delivery verification)

The bridge is a transactional outbox that re-verifies that every approved deposit actually reached
the ledger. It is the safety net for silent credit failures.

| Object | Role |
| --- | --- |
| `deposit_bridge_events` | Outbox. `status`: `PENDING, PROCESSING, DELIVERED, FAILED, RETRYING, DEAD_LETTER`; `attempt`/`max_attempts` (default 5); `next_attempt_at`; unique `idempotency_key = <source>:<source_id>` |
| `deposit_bridge_event_log` | Append-only transition audit (`log_deposit_bridge_transition`) |
| `deposit_bridge_gap_alerts` | One row per unresolved `(source, source_id)` gap |
| `bridge-worker` edge fn | Claims batches via `claim_deposit_bridge_events(worker, 50)` using `SKIP LOCKED` |
| `deposit_bridge_ledger_present(...)` | Verification probe; returns the ledger group when present |
| `mark_deposit_bridge_delivered` / `_failed` | Terminal transitions |
| `bulk_recover_gap_alerts(uuid[])` | Posts a balanced recovery pair for real gaps; closes duplicates already in `ledger_reconciled_tids` |

Enqueue is trigger-driven and idempotent (`ON CONFLICT (idempotency_key) DO NOTHING`):
`trg_dr_bridge_enqueue` on `deposit_requests` when status becomes `approved`, and
`trg_gt_bridge_enqueue` on `gmail_transactions` when `linked_deposit_request_id` is set.

**Grace period:** 60,000 ms. Events younger than 60 s that are not yet in the ledger are retried
quietly so the bridge never races the primary credit path. Past grace with no credit →
`mark_deposit_bridge_failed('No matching wallet ledger credit found after grace period')`,
escalating to `DEAD_LETTER` once `max_attempts` is exhausted.

Schedules: `deposit-bridge-worker-30s` (every 30 s), `deposit-bridge-gap-detector-5m` and
`bridge-gap-alert-notify` (every 5 min), `deposit-match-alert-notify` (every 15 min).

### 5.5 Email (Gmail) auto-credit

Pipeline: Gmail → `gmail_transactions` (parsed amount, TID, direction, counterparty) → link or
create a `deposit_requests` row → call `approve-deposit` with `system_auto_credit: true`.

Gates, all verified:

- **7-day window** on receipt age (mirrors the `approve-deposit` gate).
- **TID de-duplication**, case-insensitive, against existing `deposit_requests`.
- **Same user + amount within the window** duplicate guard.
- **Phone extraction** (`256[0-9]{9}` or `07[0-9]{8}`) matched against normalised
  `profiles.phone`; no unique match means no credit.
- **Agent Float-by-Default:** if the matched user holds an active `agent` role, purpose is forced
  to `operational_float`.
- **Channel isolation:** `auto_match_email_deposits` explicitly excludes
  `provider = 'cash_deposit'` — cash-code deposits may only credit via the receipt-code flow.
  This is the specific rule that prevents email double-crediting a cash deposit.
- **Recovery pass:** re-emits deposits whose Gmail row was linked but never approved.
- **Audit:** every outcome is written by `logDepositDecision()` to `deposit_decision_audit`
  (`auto_credited`, `failed`, `approve_non_200`, `deposit_insert_failed`, …).

Supporting tables: `gmail_transactions`, `gmail_poll_state`, `email_credit_idempotency`,
`gmail_dedup_audit`, `gmail_deposit_exclusions`, `email_payout_match_attempts`,
`email_match_audit_log`, `deposit_match_alerts`, `deposit_match_alert_config`.
Schedules: `gmail-poll-transactions-every-2min`, `email-auto-create-deposits-24h`,
`email-auto-match-retry-24h` (all every 2 min), `gmail-withdrawal-backfill-every-5min`.

### 5.6 Field deposit batches (door-to-door cash)

| Object | Role |
| --- | --- |
| `field_deposit_batches` | `status`: `awaiting_proof, pending_finops_verification, verified, rejected, cancelled`; `channel`: `mtn, airtel, bank, cash_merchant`; tracks `declared_total`, `tagged_total`, `surplus_total` |
| `field_deposit_batch_items` | Per-tenant tagging, unique on `field_collection_id`, carries `commission_amount` |
| `fdb_recalc_tagged_total()` | Keeps totals in sync on every item change |
| `field_deposit_commission_config` | Active commission rate; **no silent default** — a missing active row raises |
| `field_deposit_batch_audit` | Verification audit trail |
| `process_verified_field_deposit(batch, finops_user, proof)` | The fan-out RPC |

The RPC has two modes:

- **`withdrawable`** — rejects if any items are tagged; posts one balanced pair crediting the
  agent's own withdrawable bucket, idempotency key `field_deposit_withdrawable:<batch_id>`.
- **`operational_float`** (default) — credits agent float, then per tagged item marks
  `field_collections.status='confirmed'`, inserts `agent_landlord_float_allocations` and
  `agent_collections`, debits float (`agent_float_used_for_rent`), and credits
  `round(amount × rate)` as `agent_commission_earned` plus an `agent_earnings` row
  (`earning_type='field_collection_commission'`).

Access is locked down: `REVOKE ALL … FROM public, anon, authenticated;
GRANT EXECUTE … TO service_role` — callable only by `verify-field-deposit`.
RLS on the batch tables is gated by `is_financial_ops_staff()`.

> **Daily-capacity coupling.** "Today's capacity" (`paid_today`) reads **only** from
> `agent_collections`. Any new tenant-payment path must insert an `agent_collections` row or the
> capacity bar reads zero even though money moved.

---

## 6. Outbound value channels

### 6.1 One table, one poster

All outflow types (cash-out, landlord rent, payroll, requisitions, ROI) funnel through
`withdrawal_requests`, and `supabase/functions/approve-withdrawal/index.ts` is the only function
that posts the debit.

Observed live status distribution: `completed` 5,493 · `rejected` 2,032 · `expired` 210 ·
`approved` 139 · `cancelled` 55 · `pending` 2 · `failed` 1 · `processing` 1 ·
`re_approved_for_recovery` 1.

Lifecycle:

```text
pending/requested -> manager_approved -> cfo_approved / fin_ops_approved
      -> dispatched -> claimed -> processing -> completed
      \-> rejected | cancelled | expired | failed
```

### 6.2 Merchant dispatch and claiming

| Component | Behaviour |
| --- | --- |
| `auto_dispatch_withdrawals(batch)` | Picks `cfo_approved`, unassigned, `auto_dispatched=false`; treats amounts ≥ 500,000 as VIP; matches `cashout_agents` on `handles_cash/bank/mtn/airtel` and queue capacity; stamps `assigned_cashout_agent_id`, `dispatched_at`, increments `current_queue_count`; logs to `batch_processing_runs` |
| `accept_withdrawal_dispatch(id)` | Real-time claim. Requires an active `cashout_agents` row, locks `FOR UPDATE`, rejects if already claimed or not in an open status, stamps `dispatch_claimed_by/at`, marks the winner's `withdrawal_notification_log` row `accepted` and supersedes the rest — this is the first-agent-wins guard |
| `ignore_withdrawal_dispatch`, `merchant_set_online` | Decline / availability |
| `release_stale_cashout_claims()` | Releases only claims with **zero** settlement progress (`processing_started_at` null and no proof/code/TID) older than 45 minutes; writes `audit_logs.cashout_claim_auto_released` |
| `cashout_claim_comments`, `merchant_cashout_*` reports | Operational trail |

Schedules: `release-stale-cashout-claims` (every minute), `release-stale-cashout-claims-every-5min`,
`redispatch-withdrawals-1min`, `monitor-bulk-payout-stuck-every-15-min`.

### 6.3 `approve-withdrawal` control sequence

1. **Treasury freeze guard.** `checkTreasuryGuard(admin, "debit", authHeader)` runs before
   anything else; a declared freeze blocks all debits platform-wide.
2. **Balance gate.** Spendable balance is re-derived from ledger truth (strict RPC, **failing
   closed to 0** on RPC error), not from any cached figure. Shortfall →
   `INSUFFICIENT_WITHDRAWABLE`.
3. **Drift self-heal.** `validate_wallet_against_pivot` / `reconcile_wallet_from_pivot` run before
   the debit; unresolved drift hard-blocks with `BALANCE_MISMATCH` (HTTP 409).
4. **Merchant float pre-check.** When a merchant settles on behalf of a user, the merchant's
   `float_balance` must cover `amount + telecom charge` (tiered `TELECOM_CHARGE_TIERS`).
5. **Cash payouts require a payout code** (`WPO-xxxxx`).
6. **Ledger post.** `create_ledger_transaction` with `skip_balance_check: true` — justified
   because step 2 already enforced strict solvency.
7. **Proxy settlement.** For proxy payouts the debit lands on the **proxy agent's** wallet, then
   the partner's CFO-approved unsettled `pending_wallet_operations` (`roi_payout`, approved,
   `metadata.coo_approved_by` present) are FIFO-settled newest-first into
   `proxy_payout_settlements` (unique on `approval_id`) so paid ROI cards cannot reappear.
   Portfolio scoping is honoured when the reason text embeds `Route: portfolio <id|code>`.

### 6.4 Landlord payouts

| Step | Component |
| --- | --- |
| Issue OTP | `issue-landlord-payout-otp` → `landlord_payout_otp_challenges` (SHA-256 hashed code, 1 h TTL), SMS via Yoola → Africa's Talking → LANA chain |
| Verify | `verify-landlord-payout-otp` (status/expiry/attempt checks, idempotent `already_verified`) |
| Disburse | `landlord-payout-disburse` — freshness re-checked at 120 s; blocks a second non-`failed` `landlord_payouts` row per `rent_request_id`; reserves float via `get_agent_lp_float_available`; inserts `landlord_payouts` (`otp_verified`) and then **re-enters `withdrawal_requests`** so FinOps/merchants settle it through the standard pipeline (float is debited only at that point) |
| Related | `agent_landlord_payouts`, `agent_landlord_float`, `agent_landlord_float_allocations`, `submit-landlord-payout-receipt`, `landlord-payout-sla-monitor`, `post-float-payout-commission` |
| Schedules | `pay-landlord-rent-daily` (07:00 UTC), `welile-homes-landlord-payouts` (07:15), `welile-homes-sms-dispatch` (every 5 min), `landlord-daily-guarantee-sms` (Mon & Fri) |

### 6.5 Payroll, requisitions and standing orders

| Flow | Component | Controls |
| --- | --- | --- |
| Payroll release | `hr-pay-release` | Authorised by **position**, not role (`hr_pay_is_releaser()`, `hr_pay_is_rule_admin()`); run must be `approved`; per-payslip idempotency key `hrpay:<runId>:<payslipId>` claimed in `hr_pay_disbursements` (duplicate key = already handled); posts `salary_payout` pair; SMS only after a successful post |
| Employee requisitions | `requisition-decide` | CFO/manager/super_admin only; CFO may edit the amount; snapshots pre-decision state and **rolls the approval back** if the wallet credit fails, so "approved but uncredited" cannot persist; sets `wallet_credit_status`; retry path `requisition-credit-retry` |
| Director requisitions | `create-director-requisition`, `director-requisition-action` | `director_requisitions`, `director_requisition_events` |
| Standing orders | `process-scheduled-payouts` | `computeNextRun` per frequency (daily/weekly/interval/monthly), treasury-guarded, SMS confirmation with provider fallback |
| Payroll growth | `apply-payroll-growth` | Un-withdrawn payroll accrues 0.5%/day in `payroll_growth_balances`; FIFO-consumed on withdrawal via `consume_payroll_growth`; posted as a `system_balance_correction` wallet leg against `interest_expense` |

### 6.6 Supporter, partner and ROI outflow

| Flow | Component | Notes |
| --- | --- | --- |
| Managed ROI | `process-supporter-roi` | Treasury-guarded; pauses rewards while an `investment_withdrawal_requests` row is `pending`/`approved` with `rewards_paused`; honours `investor_portfolios.auto_reinvest`; Kampala-timezone due gating (`effectiveNextRoiDateOnly`, `isPortfolioRoiDue`) |
| Managed-proxy routing | `resolveManagedProxy` | When a partner has an active, approved `is_managed_account` proxy, wallet credits route to the proxy's wallet; enforced in-DB by `trg_enforce_managed_proxy_roi_routing` |
| Self-managed cycles | `pay_partner_self_cycles(limit)` | Pays `partner_self_payout_cycles` where `status='pending' AND cycle_end <= CURRENT_DATE`; idempotent via `ledger_group_id`; voids zero cycles; posts a `roi_expense` pair. Cron `partner-self-payouts-daily` 01:25, accrual `partner-self-returns-accrual-daily` 01:10 |
| Capital withdrawal | `investment_withdrawal_requests` | `earliest_process_date` defaults to `now() + 90 days`; submitted through `supporter-account-action`, which pauses rewards and emails the process date |

### 6.7 Outflow control matrix

| Control | Mechanism |
| --- | --- |
| Platform-wide freeze | `checkTreasuryGuard` at the top of every money-moving function |
| Strict solvency | Ledger-truth balance re-derivation, fail-closed to 0 |
| Negative-balance block | `trg_enforce_no_negative_wallet_ledger`; bypass only for `admin_correction` or `platform_loss_writeoff`, and only with a `solvency_bypass_reason` (plus a ≥30-char note for `other_with_note`) |
| KYC tiering | `kyc_level_config`: Level 1 Basic 20,000/day, 1 tx/day; Level 2 Verified 500,000/day, 10 tx/day; Level 3 Enhanced effectively unlimited. Per-account overrides live on `kyc_profiles` and are honoured by `enforce_kyc_withdrawal_cap` |
| Duplicate suppression | `prevent_duplicate_pending_withdrawal` — 15-minute window, key varies by method (provider+phone+amount, bank+account+amount, location+amount, or user+proxy+amount); raises `DUPLICATE_PENDING_WITHDRAWAL` (23505) |
| OTP / payout code | Landlord payout OTP; `WPO-xxxxx` cash payout codes; `sms-otp` |
| SMS verification monitoring | `detect_sms_verification_failures` (15 min) + `get_sms_verification_metrics` |
| Transfer eligibility | User-to-user transfers require 10+ completed deposits |
| Merchant auto-debit block | `trg_block_merchant_agent_auto_debit` |
| Proxy custody protection | `trg_block_proxy_custody_writes` |
| Retired paths | `wallet-deduction` returns HTTP 410; `trg_block_legacy_wallet_deduction` blocks its ledger shape. All wallet→platform debits go through CFO Direct Debit (`cfo-direct-credit`, `operation: debit`), which posts ledger legs only and never creates a debt row |

---

## 7. Credit and liability inventories

### 7.1 Recovery isolation rule (applies to every product below)

Recovery only ever draws from the **withdrawable** bucket. Float, custody and unsettled
commission are never swept. This is enforced structurally: recovery categories require an explicit
`recipient_type` in `create_ledger_transaction`, and `assert_routing_compatible` rejects the
combinations that would reach the wrong bucket.

### 7.2 Agent advances

| Object | Role |
| --- | --- |
| `agent_advance_requests` (36 cols) | Request pipeline, 4 approval stages |
| `agent_advances` (29 cols) | Active liability |
| `agent_advance_ledger` | Per-advance movement history |
| `agent_advance_topups` | Top-ups against an existing advance |
| `advance_fee_config` | `default_monthly_rate=0.33`, `min_rate=0.28`, `max_rate=0.33` |
| `agent_advance_repayment_monitor` (RPC `get_agent_advance_repayment_monitor`) | Agent Ops surface |

**Pricing.** Compound monthly access fee:
`principal × ((1 + monthlyRate)^(days/30) − 1)` (`src/lib/agentAdvanceCalculations.ts`).
Registration fee 10,000 for principal ≤ 200,000, otherwise 20,000.

**Limit engine** (`get_agent_advance_potential`, current constants):
base floor 20,000; first-time agents get 30% of computed capacity; repeat agents
`LEAST(1.0, 0.50 + 0.40×repay_rate + 0.10×repaid_ratio)`; score multiplier `score^1.3 × 900,000`;
hard ceiling **9,000,000**.

**Single-advance rule.** `enforce_no_double_agent_advance()` raises when an `active`/`overdue`
advance with `outstanding_balance > 0` exists, or a request is already in the pipeline. The only
exception is `request_kind='topup'`, gated by `agent_advance_topup_eligibility` (≥30% repaid, not
behind schedule, top-up ≤ 90% of current principal).

**Recovery.** `sweep_agent_advance_recovery()` sweeps FIFO by `issued_at` over
`status in ('active','overdue')`, using **scheduled installments, not calendar days**, so
weekly/bi-weekly/monthly advances are only deducted on their due day
(`advance_period_days`, `advance_installment_amount`, `advance_expected_repaid_to_date`).
Missing a day does **not** increase the outstanding balance (`interest_accrued = 0` on sweep).
Ledger shape: wallet `agent_repayment` `cash_out` (`recipient_type=user`) against platform
`agent_repayment` `cash_in` (`recipient_type=operational_wallet`),
`metadata.source='auto_withdrawable_sweep'`.

**Arrears clawback.** `tg_cap_advance_arrears` bounds `arrears_balance`;
`recover_agent_arrears_from_credit()` (via `trg_recover_advance_arrears_on_earning`) intercepts
new earnings and pulls against the oldest arrears with
`metadata.source='arrears_credit_intercept'`.

**Voluntary prepayment.** `voluntary-repay-advance`, `cfo-record-advance-payment`,
`StaffRepayAdvanceDialog`. Notifications: `notify-advance-deduction`,
`send-advance-payment-reminder`, `notify-agent-advance-disbursed`.
Schedules: `daily-advance-deductions` and `sweep-agent-advance-recovery` at 14:50 UTC (17:50 EAT),
`trigger-agent-liability-daily` 23:00.

### 7.3 Business advances

`business_advances` (56 cols) with enum `business_advance_status`:
`pending → agent_ops_approved → tenant_ops_approved → landlord_ops_approved → coo_approved →
cfo_disbursed → active → completed` (plus `rejected`, `defaulted`).

Supporting: `business_advance_repayments`, `business_advance_daily_accruals`,
`business_advance_documents`, `business_advance_notification_log`, `business_advance_share_events`.

**Limit engine** (`calculate_business_advance_limit`): 50,000 starter with no rent history;
otherwise `avg_rent × months_recorded` (capped at 12 months), +20% consistency bonus at ≥6 months,
+15% loyalty bonus for ≤2 distinct landlords, +25% tenure bonus at 12 full months, then
`LEAST(total, 10,000,000)`.

Functions: `disburse-business-advance`, `repay-business-advance`,
`process-business-advance-compounding` (`business-advance-daily-compounding` 23:00),
`business-advance-stage-reminders` (every 30 min), `claim-business-advance-account`.

### 7.4 Credit access draws

`credit_access_limits`, `credit_access_draws`, `credit_draw_ledger`, `credit_request_details`,
`credit_limit_reconciliation_alerts`.

Draws are created as `pending_cfo` and are **never auto-credited**. The CFO edits and approves via
`cfo-approve-credit-draw`, which disburses into the withdrawable bucket. Daily charges run through
`process-credit-daily-charges` (`daily-credit-charges` 06:00); drift is watched by
`detect-credit-limit-drift-15min`; the recalculation cron
`daily-recalculate-credit-limits` is currently **inactive**.

### 7.5 HR pay advances

`hr_pay_advances` and `hr_pay_advance_recoveries` (both live). Columns include `staff_id`,
`principal`, `recovery_mode`, `recovery_value`, `first_recovery_on`, `status`, and the
approval-stamp trio `approved_by` / `approved_position_id` / `approved_at`, which is written by a
**database trigger from the caller's position** — never by client code.

Recovery is a **payroll deduction**, not a wallet sweep: `calculate.ts` calls the
`hr_pay_advance_due` RPC during a run and inserts `hr_pay_advance_recoveries` rows tied to
`hr_pay_runs.run_id`, reducing net pay. `hr_pay_advance_guard` protects the invariants.

### 7.6 Welile Vouch Network

This is a **guarantee** product, not a Welile-issued advance: third-party lenders record loans
against a borrower's Welile Trust Score limit.

| Table | Role |
| --- | --- |
| `lender_partners` | Registered lenders |
| `vouch_claims` | `borrower_user_id`, `principal_ugx`, `vouched_amount_ugx`, `trust_score_at_record`, `status` (`active, repaid, defaulted, claim_paid, disputed`), `recovery_status` (`none, recovering, fully_recovered`), `recovered_amount_ugx`, `claim_paid_amount_ugx` |
| `borrower_vouch_disclosures` | Consent log (`disclosure_version`, limit at acknowledgement) |
| `lender_vouch_agreement_acceptance`, `lending_agent_agreement_acceptance` | Agreement records |
| `agent_vouch_limit_history` | Limit change history |
| `default_recovery_ledger` | Platform-wide written-down exposure recovery |
| `apply_layer_a_writedown` | Books losses as `platform_loss_writeoff` |

Deduction automation: `lending-auto-deduct-daily` (06:00). `process-debt-recovery-daily` is
currently **inactive**.

### 7.7 Rent plans (tenant obligations)

Lifecycle (live distribution): `repaying` 590 · `completed` 380 · `rejected` 180 ·
`pending` 139 · `funded` 99 · `deleted_by_agent` 78 · `agent_ops_approved` 8 ·
`tenant_ops_approved` 5 · `cancelled` 1.

```text
pending -> agent_ops_approved -> tenant_ops_approved -> landlord_ops_approved
        -> COO approval -> CFO funding -> funded -> repaying -> completed
        \-> rejected | cancelled | deleted_by_agent
```

| Concern | Implementation |
| --- | --- |
| Obligation creation | `rent_receivable_created` (scope `bridge`) |
| Disbursement | wallet/float `rent_disbursement` `cash_out` ↔ platform `landlord_rent_payment` `cash_in`; `trg_enforce_single_rent_disbursement` prevents a double payout |
| Repayment intake | `tenant-pay-rent`, `manual-collect-rent`, `submit-offline-collection`, `agent_allocate_tenant_payment` (must also write `agent_collections`) |
| Auto-charge | `auto-charge-wallets-daily` 06:00, `retry-no-smartphone-charges-3h` |
| Overdue penalty | `apply-rent-overdue-penalty`: 33% of outstanding after a 30-day grace beyond term (`apply-rent-overdue-penalty-daily` 06:30) |
| Auto-close | `auto_close_fully_repaid_rents()` flips `funded`/`repaying` → `completed` once `amount_repaid >= total_repayment`; cron 23:00 UTC (02:00 Kampala) |
| Agent cancel | `agent_cancel_rent_request` RPC with a mandatory reason; terminal status `deleted_by_agent` |
| Guard | `guard_rent_request_agent_updates` whitelists agent-driven transitions, including `repaying → completed` |
| Reminders | `rent-reminders`, `payment-reminder`, `notify-agent-collection-lapse`, `rent-amount-change-notify` (10 min) |

---

## 8. Revenue recognition

### 8.1 Time-elapsed recognition (ASC 606 / IFRS 15 style)

`fee_revenue_ledger` is the revenue sub-ledger. Fees are **not** recognised when charged; they are
recognised over the life of the facility.

| Column | Meaning |
| --- | --- |
| `fee_type` | e.g. `agent_advance_access_fee`, `rent_service_fee`, `business_advance_fee` |
| `gross_fee_amount` | Total contractual fee |
| `recognized_amount` | Earned to date |
| `deferred_amount` | `gross − recognized` (contract liability) |
| `recognition_start_date` / `recognition_end_date` | Service window |
| `status` | `deferred`, `partially_recognized`, `fully_recognized`, `written_off` |
| `source_table` / `source_id` | Link back to the originating facility |

`recognize_fee_revenue_daily()` recognises straight-line by elapsed days:

```text
target_recognized = gross_fee_amount × LEAST(1, elapsed_days / total_days)
increment         = target_recognized − recognized_amount   -- posted only when > 0
```

Recognition posts a platform pair (deferred-revenue relief → earned revenue) and never touches a
wallet. Early settlement recognises the remainder immediately; write-offs move the balance to
`platform_loss_writeoff`.

### 8.2 Revenue streams

| Stream | Category | Basis |
| --- | --- | --- |
| Agent advance access fee | `agent_advance_fee` | Compound monthly, recognised over term |
| Business advance fee | `business_advance_fee` | Daily compounding accruals |
| Rent service fee | `rent_service_fee` | Over the rent term |
| Registration fees | `registration_fee_collected` (259 rows / 2,900,000) | Point in time |
| Telecom charge margin | embedded in payout tiers | Point of settlement |
| Merchandise margin | `merchandise_sale` | Point of sale |
| Penalty income | `rent_overdue_penalty` | On assessment |

### 8.3 Expense recognition

| Expense | Category | Live volume |
| --- | --- | --- |
| Supporter/partner ROI | `roi_expense` | 2,142 rows / 2,255,106,800 |
| Marketing / referral | `marketing_expense` | 102,187 rows / 155,747,196 |
| General admin | `general_admin_expense` | 563 rows / 1,147,164,039 |
| Payroll | `payroll_expense` | 111 rows / 62,066,999 |
| Credit losses | `platform_loss_writeoff` | 478 rows / 465,473,700 |
| Interest on payroll growth | `interest_expense` | Daily 0.5% accrual |

---

## 9. Commissions, bonuses and incentives

### 9.1 Accrual then release

`commission_accrual_ledger` holds accruals with a lifecycle of
`accrued → released → (reversed)`. Only a **released** accrual has a matching withdrawable ledger
credit. `v_user_wallet_strict` explicitly subtracts legs whose accrual is `reversed` for the
`rent_funded_landlord_float` event — a reversed commission cannot be withdrawn even if its original
leg is still in the append-only ledger.

### 9.2 Earning types (verified live volumes)

| Category | Rows | Amount |
| --- | --- | --- |
| `agent_commission_earned` | 39,140 | 953,122,287 |
| `agent_commission` | 57,651 | 115,957,758 |
| `referral_bonus` | 47,562 | 18,484,000 |
| `agent_commission` (bridge) | 2,363 | 1,766,095 |

Verification bonuses: landlord verified and LC verified both pay **2,000**.

### 9.3 Single source of truth for withdrawable commission

The **Agent Wallet Card** (`UnifiedWalletHeroCard`) is the only authoritative display of
withdrawable commission. Merchant agent commission was folded into the same wallet projection, so
there is exactly one number per agent across the platform.

### 9.4 Referral attribution

`src/lib/referralAttribution.ts` persists the referral code in `localStorage` for **60 days** and
survives auth redirects, which fixed the "sub-agents not appearing" class of bug.
`merchant_agent_referrals` tracks merchant-side recruitment; field recruitment campaigns are
tracked separately with their own tables and reports.

---

## 10. Supporter and partner capital

### 10.1 Two operating models

| Model | Who decides | Payout engine |
| --- | --- | --- |
| **Managed** | Welile allocates capital | `process-supporter-roi`, `roi_wallet_credit` (1,573 rows / 1,694,280,035) |
| **Self-managed (PSM)** | The partner picks tenants/portfolios | `pay_partner_self_cycles()`, `partner_self_payout_cycles` |

### 10.2 PSM object model

`partner_self_commitments` → `partner_self_funding_lines` → `partner_self_return_accruals` →
`partner_self_payout_cycles`.

- Accrual: `partner-self-returns-accrual-daily` 01:10.
- Payout: `partner-self-payouts-daily` 01:25, idempotent through `ledger_group_id`.
- UI: `SelfPortfolioFundingCard`, `FunderCapitalOpportunities` (stacked cards with bulk selection).

### 10.3 Double-debit protection

`enforce_portfolio_portfolio_funding_at_creation` blocks a second identical funding debit for the
same partner/portfolio/amount inside a **±30-minute** window. This closed a real incident where a
trigger path and an application path both debited 100,000.

### 10.4 Capital withdrawal

`investment_withdrawal_requests` defaults `earliest_process_date` to `now() + 90 days`. Filing a
request pauses reward accrual (`rewards_paused`) so a partner cannot earn ROI on capital already
queued for exit.

---

## 11. Automation and scheduling

### 11.1 Schedule map (verified via `cron_jobs_health()`)

| Cadence | Jobs |
| --- | --- |
| Every 30 s | `deposit-bridge-worker-30s` |
| Every minute | `expire-cash-deposit-codes`, `release-stale-cashout-claims`, `redispatch-withdrawals-1min` |
| Every 2 min | `gmail-poll-transactions-every-2min`, `email-auto-create-deposits-24h`, `email-auto-match-retry-24h` |
| Every 5 min | `deposit-bridge-gap-detector-5m`, `bridge-gap-alert-notify`, `gmail-withdrawal-backfill-every-5min`, `release-stale-cashout-claims-every-5min`, `welile-homes-sms-dispatch` |
| Every 10 min | `reconcile-wallets-batch`, `rent-amount-change-notify` |
| Every 15 min | `deposit-match-alert-notify`, `detect-sms-verification-failures`, `detect-credit-limit-drift-15min`, `monitor-bulk-payout-stuck-every-15-min` |
| Every 30 min | `business-advance-stage-reminders` |
| Every 3 h | `retry-no-smartphone-charges-3h` |
| Daily 00:00 | Daily Wallet Financial Summary report |
| Daily 01:10 / 01:25 | PSM accrual / PSM payouts |
| Daily 06:00 | `auto-charge-wallets-daily`, `daily-credit-charges`, `lending-auto-deduct-daily` |
| Daily 06:30 | `apply-rent-overdue-penalty-daily` |
| Daily 07:00 / 07:15 | `pay-landlord-rent-daily`, `welile-homes-landlord-payouts` |
| Daily 14:50 UTC | `daily-advance-deductions`, `sweep-agent-advance-recovery` |
| Daily 23:00 | `auto_close_fully_repaid_rents`, `business-advance-daily-compounding`, `trigger-agent-liability-daily` |
| Weekly | `landlord-daily-guarantee-sms` (Mon & Fri) |
| Fortnightly | Rejected-listing purge (14-day retention) |
| Inactive | `daily-recalculate-credit-limits`, `process-debt-recovery-daily` |

### 11.2 Idempotency patterns in use

| Pattern | Where |
| --- | --- |
| Advisory-lock + existing-group return | `create_ledger_transaction(idempotency_key)` |
| Deterministic key claim | `hrpay:<runId>:<payslipId>` in `hr_pay_disbursements` |
| Source-row probe | `approve-deposit` checks for an existing `source_table`/`source_id` credit |
| Unique outbox key | `deposit_bridge_events.idempotency_key = <source>:<source_id>` |
| Group-id stamp | `partner_self_payout_cycles.ledger_group_id` |
| Unique settlement row | `proxy_payout_settlements.approval_id` |
| Time-window guard | Portfolio funding ±30 min; duplicate withdrawal 15 min |

---

## 12. Reconciliation and drift control

### 12.1 Layered defence

| Layer | Mechanism | Cadence |
| --- | --- | --- |
| 1 — Prevention | 34 `general_ledger` triggers | Per write |
| 2 — In-transaction projection | `tg_refresh_wallet_projection_on_ledger` | Per write |
| 3 — Pre-debit validation | `validate_wallet_against_pivot` + `reconcile_wallet_from_pivot` in `approve-withdrawal` | Per withdrawal |
| 4 — Batch heal | `reconcile_wallets_batch` | Every 10 min |
| 5 — Delivery verification | Deposit bridge + `verify_ledger_delivery` | 30 s / on demand |
| 6 — Detection | `detect_wallet_projection_drift` → `wallet_projection_drift_alerts` | Scheduled, log-only |
| 7 — Reporting | Daily Wallet Financial Summary | 00:00 EAT |

### 12.2 Drift semantics

`detect_wallet_projection_drift()` compares `wallet_balances_projection` to
`v_user_wallet_strict` and **only logs**. `reconcile_wallets_batch()` performs the write-back,
bounded per run so a bad batch cannot cascade. Because the strict view is definitionally correct,
reconciliation always moves the projection toward the ledger — never the reverse.

### 12.3 Reconciliation registries

`ledger_reconciled_tids` (TIDs already accounted for, used by `bulk_recover_gap_alerts` to close
false gaps), `ledger_integrity_config` (`enforce_from` grandfather date),
`wallet_fresh_start_anchors` (per-account re-basing).

### 12.4 Bucket-aware obligation guard

`trg_enforce_bucket_aware_obligation` prevents debt cross-contamination: an obligation attached to
one bucket cannot be satisfied from another. Combined with the mandatory `recipient_type` on
recovery categories, this is what keeps float and custody money out of debt recovery.

---

## 13. Anomaly detection and alerting

| Signal | Detector | Sink |
| --- | --- | --- |
| Wallet projection drift | `detect_wallet_projection_drift` | `wallet_projection_drift_alerts` |
| Credit limit drift | `detect-credit-limit-drift-15min` | `credit_limit_reconciliation_alerts` |
| Deposit delivery gap | `deposit-bridge-gap-detector-5m` | `deposit_bridge_gap_alerts` |
| Email match anomalies | `deposit-match-alert-notify` | `deposit_match_alerts` |
| SMS/OTP failure spike | `detect_sms_verification_failures` | `system_events` + SMS metrics |
| Stuck bulk payouts | `monitor-bulk-payout-stuck-every-15-min` | Ops alert |
| Landlord payout SLA | `landlord-payout-sla-monitor` | Ops alert |
| Overdraw attempts | `wallet_overdraw_events` | Table |
| Routing violations | `wallet_routing_violations`, `wallet_unrouted_movements` | Tables |
| Writer failures | `system_events` (`wallet.writer_failed`) | Table |
| Duplicate accounts | `CFOInitiateAdvanceDialog` duplicate detection | UI + audit |
| Fraud earnings | `trg_enforce_no_fraud_wallet_earnings` | Hard block |

---

## 14. Controls, authorisation and security

### 14.1 Authorisation model

- **RLS everywhere:** 452/452 public tables, 1,189 policies.
- **Position-based authority for payroll:** `hr_pay_is_releaser()` / `hr_pay_is_rule_admin()` check
  the employee's **position**, not a role claim, so a role grant alone cannot release salary.
- **Role-based authority elsewhere:** `is_financial_ops_staff()`, CFO/COO/super_admin gates.
- **Service-role-only RPCs:** field deposit processing is revoked from `public`, `anon`,
  `authenticated` and granted to `service_role` alone.
- **Department→role sync:** `trg_sync_operations_department_role` keeps DB roles aligned with
  department assignment.

### 14.2 Column-level integrity guards

Trigger guards block self-modification of sensitive columns even where a broad `UPDATE` policy
exists: `profiles` sensitive columns, `landlords` financial fields,
`welile_homes_subscriptions` balances, `kyc_level_config`, `credit_access_limits`,
`audit_logs` (ownership-checked writes only).

### 14.3 Identity and eligibility gates

| Gate | Component |
| --- | --- |
| Phone + mobile-money name capture | `PhoneCollectionGate`, `MobileMoneyNameCard`, OTP verified |
| Real-name validation | `NameCompletionGate` (≥2 names, rejects random character strings) |
| Frozen agent lockout | `AgentFrozenGate` (full-screen legal banner) |
| KYC withdrawal cap | `enforce_kyc_withdrawal_cap` (Level 1 = 20,000/day; per-account overrides) |
| Transfer eligibility | 10+ completed deposits required |

### 14.4 Data-exposure controls

- **Running Balance** is hidden from all agent- and user-facing statements, drawers and PDFs;
  `LedgerEntryDetailDrawer` reveals it only to finance/audit roles.
- Vendor PINs are never selected by UI reads (explicit column lists).
- Map/browser API keys are not publicly readable.
- Resume/PII tables restrict read access to HR.

---

## 15. Reporting surfaces

| Report | Cadence | Delivery |
| --- | --- | --- |
| Daily Wallet Financial Summary | 00:00 EAT | Email |
| Daily Rent Report (`DailyRentReport`) | Daily | PDF via `pg_cron` |
| CMO daily performance | Daily | Email |
| Agent advance repayment monitor | On demand | Agent Ops dashboard |
| Merchant cashout reports | On demand | FinOps |
| Wallet statements | On demand | PDF (no running balance for end users) |
| Publish/build diagnostics | Per build | `public/build-log.txt` (legacy domains redacted) |

Executive surfaces: CEO/CFO/COO dashboards, `AgentOpsDashboard`, `TenantOpsHub`,
`LandlordOpsDashboard` (server-side search), `CfoPayrollPanel` (dry-run + typed `RELEASE`
confirmation).

---

## 16. Known gaps and risk register

| # | Finding | Severity | Detail |
| --- | --- | --- | --- |
| 1 | `detect_phantom_wallet_drift` references a table dropped in migration history but present in the live DB | Medium | Migration history and live schema disagree. Live DB is truth; the migration record should be reconciled before any environment rebuild, or a fresh environment will fail to create this function. |
| 2 | `daily-recalculate-credit-limits` inactive | Medium | Credit limits are not recomputed on a schedule; drift detection still runs, so the symptom would be stale limits rather than silent loss. |
| 3 | `process-debt-recovery-daily` inactive | Medium | Platform-wide written-down exposure recovery is not sweeping automatically. |
| 4 | Daily-capacity coupling to `agent_collections` | Medium | `paid_today` reads only `agent_collections`; a new payment path that skips it silently reports zero capacity. |
| 5 | `admin_correction` volume (8,531 rows) | Medium | Corrections are excluded from user statements but are a standing indicator of upstream defects; the trend should be tracked, not just the count. |
| 6 | `test_dev` rows (676) in production tables | Low | Non-economic residue; excluded from strict balances but pollutes raw exports. |
| 7 | `legacy_real` rows (2,797) pre-cutover | Low | Retained for history; must always be filtered out of post-April reporting. |
| 8 | `apply_wallet_movement` retained as a no-op | Low | Intentional (call-site compatibility), but a future reader may mistake it for a live writer. Its comment states the invariant. |
| 9 | `skip_balance_check: true` in `approve-withdrawal` | Low (by design) | Safe only because strict solvency is checked immediately before. Any refactor that removes the pre-check silently removes the solvency guarantee. |
| 10 | Build memory ceiling | Low | Node heap pinned to 4,096 MB; SEO steps are wrapped in `scripts/run-optional.mjs` so they cannot fail the publish. |

---

## 17. Appendices

### Appendix A — Ledger category allow-list (from `ledger_category_allowlist()`)

Deposits and intake: `wallet_deposit`, `agent_float_deposit`, `agent_float_assignment`,
`agent_float_settlement`, `agent_float_used_for_rent`, `field_deposit_commission`,
`angel_pool_investment`, `historical_balance_reseed`, `pending_portfolio_topup`.

Withdrawals and payouts: `wallet_withdrawal`, `wallet_transfer`, `rent_disbursement`,
`landlord_rent_payment`, `salary_payout`, `roi_payout`, `roi_wallet_credit`, `roi_expense`,
`merchant_settlement`.

Credit and recovery: `agent_advance_credit`, `agent_repayment`, `agent_advance_repayment`,
`agent_advance_fee`, `business_advance_credit`, `business_advance_fee`, `salary_advance_repayment`,
`debt_recovery`, `credit_draw`, `platform_loss_writeoff`.

Earnings: `agent_commission`, `agent_commission_earned`, `referral_bonus`, `verification_bonus`.

Revenue and expense: `rent_service_fee`, `registration_fee_collected`, `rent_overdue_penalty`,
`marketing_expense`, `general_admin_expense`, `payroll_expense`, `interest_expense`,
`merchandise_sale`.

Capital and partners: `partner_funding`, `supporter_facilitation_capital`.

Corrections: `system_balance_correction`, `wallet_deduction`,
`wallet_deduction_general_adjustment`, `rent_receivable_created`, `rent_payment_for_tenant`.

*(~110 entries total; the function body is authoritative.)*

### Appendix B — Key RPCs

| RPC | Purpose |
| --- | --- |
| `create_ledger_transaction` | The only authorised ledger writer |
| `user_wallet_strict` / `v_user_wallet_strict` | Ledger-truth balance |
| `get_user_available_balance` | Projection read used by the UI |
| `get_user_float_available_balance` | Float availability (now 11 ms, was 6.2 s) |
| `validate_wallet_against_pivot` / `reconcile_wallet_from_pivot` | Per-withdrawal drift check/heal |
| `reconcile_wallets_batch` | 10-minute batch heal |
| `verify_ledger_delivery` | Server-side delivery verification |
| `sweep_agent_advance_recovery` | Installment-aware advance recovery |
| `get_agent_advance_potential` | Limit engine (20,000 floor / 9,000,000 ceiling) |
| `calculate_business_advance_limit` | Business advance limit engine |
| `recognize_fee_revenue_daily` | Time-elapsed revenue recognition |
| `pay_partner_self_cycles` | PSM payouts |
| `process_verified_field_deposit` | Field batch fan-out (service role only) |
| `auto_dispatch_withdrawals` / `accept_withdrawal_dispatch` | Merchant dispatch and claiming |
| `release_stale_cashout_claims` | 45-minute claim release |
| `agent_cancel_rent_request` | Cancellation with mandatory reason |
| `auto_close_fully_repaid_rents` | Rent plan auto-close |

### Appendix C — Reading the system safely

1. **Never write a balance.** Post a balanced ledger group and let the projection follow.
2. **Always pass `recipient_type`** on recovery categories, or the write is rejected.
3. **Always pass an `idempotency_key`** for anything an automation or a user can retry.
4. **Check the classification filter** before quoting any total: `production` only, and only from
   2026-04-01 onward for post-cutover reporting.
5. **Trust `v_user_wallet_strict`, not `wallets`,** when investigating a disputed balance.