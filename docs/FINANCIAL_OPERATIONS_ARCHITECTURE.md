# Financial Operations (FinOps) Architecture Manual

**Audience:** CTO, CFO, Finance Team, Auditors, Engineers, Compliance Officers, future AI assistants.
**Status:** Reverse-engineered from the live database (`wirntoujqoyjobfhyelc`) and the repository at the date of writing. Every claim is marked **[observed]** (verified by direct query / file read) or **[inferred]** (deduced from naming or partial evidence).
**Scope:** the dual-persona FinOps surface — the Financial Ops Command Center (`src/components/financial-ops/`, ~74 files) and CFO Strategic Controls (`src/components/cfo/`, ~93 files) — plus ~75 finance-critical Edge Functions, ~180 SECURITY DEFINER finance RPCs, 34 `general_ledger` triggers and the pg_cron fleet.

> **Read this first — three verified defects that undermine the control model.**
> 1. **`admin_reseed_wallet_cache` is an arbitrary money-write primitive.** SECURITY DEFINER, **no role check**, sets `wallet.sync_authorized='true'` to defeat `enforce_wallet_ledger_only`, overwrites any user's `balance`/`withdrawable_balance`, resets the flag. ACL grants EXECUTE to **`anon` and `authenticated`**. **[observed]**
> 2. **`begin_wallet_accrual_lock` / `end_wallet_accrual_lock` have no authorization** and PUBLIC EXECUTE. `wallet.accrual_lock='on'` is an absolute block on all wallet mutation, set with `is_local=false` (session-persistent). Any caller can freeze wallet updates platform-wide. **[observed]**
> 3. **Nine cron jobs are `active=false` and stale**, including `process-debt-recovery-daily`, `daily-recalculate-credit-limits`, `check-agent-liquidity-hourly`, `refresh-financial-summaries-daily`, `process-promissory-deductions-daily`, `partner-ops-automation-daily`. Recovery and credit-limit maintenance are silently not running. **[observed via `cron_jobs_health()`]**

---

## 1. Scope and Persona Split

| Tier | Location | Entry point | Purpose |
|---|---|---|---|
| Financial Ops | `src/components/financial-ops/` (~74 files) | `FinancialOpsCommandCenter.tsx` (922 lines) + `FinancialOpsPulseStrip.tsx` | Day-to-day cashier/verification desk: deposits, withdrawals, email auto-match, requisitions, reconciliation review |
| CFO / Treasury | `src/components/cfo/` (~93 files), `src/pages/cfo/*` | `src/pages/cfo/Dashboard.tsx` | Executive/treasury: advances, payroll, ledger health, cash position, ROI, cron and anomaly monitoring |

`FinancialOpsCommandCenter` lazy-loads ~45 panels through an `lz()` helper so first paint stays fast, and by explicit **CFO mandate** (in-file comment) the home view exposes only two primary actions — *Verify Deposits* and *Withdrawals*; ~33 other tools live behind a "More" sheet. **[observed]** The command center performs **no route-level RBAC of its own**; it reads `useAuth()` only to namespace localStorage UI preferences. Authorization is the page wrapper's and each Edge Function's responsibility. **[observed]**

`FinancialOpsPulseStrip` renders 5 KPI tiles from a single `get_financial_ops_pulse()` RPC ("instead of 5 separate queries — handles 1M+ scale"). **[observed]**

## 2. The One Sanctioned Money-Movement Path

Every legitimate movement of value is a **balanced, multi-leg insert into `general_ledger` through the `create_ledger_transaction` RPC**. There is no second sanctioned writer.

`create_ledger_transaction(entries jsonb, idempotency_key text DEFAULT NULL, skip_balance_check boolean DEFAULT false)` — canonical. A legacy 4-arg overload `(p_transaction_group_id, p_entries, p_idempotency_key, p_skip_balance_check)` exists and **deliberately discards the passed group id** ("the transaction group id argument is intentionally ignored") before delegating. **[observed]**

Behaviour, in order:
1. `set_config('ledger.authorized','true', true)` — satisfies the `enforce_ledger_rpc_only` guard for the ensuing inserts. This is transaction-local.
2. **Idempotency:** `pg_advisory_xact_lock(hashtext(idempotency_key))`, then look up an existing group by that key and **return it unchanged** if found. Idempotent replay, never an upsert.
3. **Entry contract** per array element: `user_id, category, direction ('cash_in'|'cash_out'), amount, ledger_scope, recipient_type?, wallet_bucket?, classification?, description, reference_id, source_table, source_id, currency, account, transaction_date, solvency_bypass_reason?`.
4. **Isolation rule:** for `ledger_scope='wallet'` with category in `agent_repayment, agent_advance_repayment, salary_advance_repayment, debt_recovery`, `recipient_type` is **mandatory**; violations are logged to `wallet_routing_violations` and raise `check_violation`.
5. **Bucket resolution:** explicit `wallet_bucket` wins; else `operational_wallet → float`, `user → withdrawable`.
6. **Balance enforcement** only when `NOT skip_balance_check AND ledger_scope='wallet' AND user_id IS NOT NULL AND effective_bucket='withdrawable'`. It derives a strict ledger net since the user's `wallet_fresh_start_anchors.anchor_at`, limited to `classification IN (NULL,'production')`, then enforces `LEAST(cached_withdrawable, strict_net)` — **the cache can only lower the ceiling, never raise it.** Shortfall raises `Insufficient ledger balance`.
7. Hard assertion that `SUM(cash_in) = SUM(cash_out)` across the whole array.
8. One row per entry, all sharing one freshly generated `transaction_group_id`.

**[all observed]**

## 3. `general_ledger`: Shape, Classification, Immutability

31 columns. Notable: `transaction_group_id` (default `gen_random_uuid()`), `ledger_scope` (default `'wallet'`), `classification` (plain **text**, not an enum), `idempotency_key`, `recipient_type`, `wallet_bucket`, `routing_source`, `solvency_bypass_reason`, plus a maturity family (`withdrawable_after, maturity_condition, maturity_met, maturity_subject_id, maturity_expired, matured_at`). **[observed]**

`solvency_bypass_reason` **is** a real enum, 8 labels: `legacy_offline_paid, write_off, admin_correction_seed, legacy_real_backfill, dispute_resolution, regulatory_adjustment, duplicate_reversal, other_with_note`. **[observed]**

Live distributions **[observed]**:

| Dimension | Values |
|---|---|
| `classification` | `production` 360,306 · `admin_correction` 8,532 · `legacy_real` 2,797 · `test_dev` 676 |
| `ledger_scope` | `wallet` 187,212 · `platform` 174,444 · `bridge` 10,655 |
| Volume | 372,311 rows across 182,692 distinct groups; 187,491 rows carry an idempotency key |
| `wallet_bucket` | `''` 337,381 · `withdrawable` 25,461 · `float` 9,469 (of which 9,465 are `recipient_type='operational_wallet'`) |

**RLS is deny-all for client writes:** `no_deletes` (UPDATE qual `false`), `no_updates`, `no_direct_inserts` (with_check `false`). SELECT is limited to execs (cfo/coo/ceo), managers, and self via `is_customer_wallet_history_visible`. No client can write a ledger row through PostgREST at all. **[observed]**

## 4. The 34 `general_ledger` Triggers

Grouped by function. **[all observed via `pg_trigger` / `pg_get_triggerdef`]**

**Write authorization / immutability**
- `trg_enforce_ledger_rpc_only` → `enforce_ledger_rpc_only` — requires `ledger.authorized='true'` unless (a) a maintenance window is open (`ledger_maintenance_state.open_until`), logged as `ledger_maintenance_write`, or (b) break-glass `ledger.bypass_guard='true'`, logged as `ledger_guard_bypass`. **The break-glass path contains no role check of its own.**
- `trg_prevent_ledger_update` / `trg_prevent_ledger_delete` → `prevent_ledger_mutation` — append-only enforcement.
- `trg_guard_ledger_write` → `guard_ledger_write` — same `ledger.authorized` check with no carve-outs.

**Double-entry and classification integrity**
- `trg_enforce_ledger_group_balance` (**AFTER, DEFERRABLE INITIALLY DEFERRED**) — at commit, each `transaction_group_id` must net to exactly zero. `system_balance_correction` groups may mix `production` + `admin_correction` and still must net zero; mixing those classifications outside a correction group is forbidden. Governed by `ledger_integrity_config.enforce_from`.
- `trg_enforce_correction_classification`, `trg_enforce_production_april_cutoff` (forces `production` for `transaction_date >= 2026-04-01` unless already `admin_correction`), `trg_validate_ledger_category`.

**Routing**
- `trg_set_wallet_bucket_from_recipient_type`, `trg_assert_wallet_routing` (raises `WALLET_ROUTING_REQUIRED` when no bucket resolves), `trg_auto_ledger_scope`, `zz_enforce_wallet_scope_requires_user`, `general_ledger_route_buckets`, `trg_enforce_managed_proxy_roi_routing`.

**Anti-fraud / retired-path blocks**
- `trg_block_legacy_wallet_deduction` (rejects `category='wallet_deduction'`, retired 2026-05-01 in favour of `cfo-direct-credit` + `cfo_debit_obligations`), `trg_block_merchant_agent_auto_debit`, `trg_block_proxy_custody_writes`, `trg_block_retired_instant_house_reward`, `trg_enforce_no_fraud_wallet_earnings`, `trg_enforce_no_negative_wallet_ledger`, `trg_enforce_single_rent_disbursement`, `trg_enforce_tid_deposit_uniqueness`, `trg_verify_advance_disbursement`.

**Projections and side-effects**
- `trg_wallet_projection_ledger` → `tg_refresh_wallet_projection_on_ledger`, `trg_wallet_projection_maturity`, `trg_ledger_pivot_apply`, `trg_ledger_running_balance`, `trg_sync_wallet_from_ledger`, `trg_apply_bonus_restriction`, `trg_recover_advance_arrears_on_earning`, `trg_notify_agent_commission_paid`, `trg_log_ledger_wallet_transfer`, `trg_ensure_depositor_profile_on_credit`, `trg_general_ledger_supporter_capital`.

## 5. Wallet Architecture: Truth, Cache, and Two Dead Writers

`wallets` is a **VIEW**, not a table:
```sql
SELECT wp.id, wp.user_id, COALESCE(p.total_visible,0) AS balance, wp.created_at, wp.updated_at,
       wp.locked_balance, wp.currency, COALESCE(p.withdrawable,0), COALESCE(p.float_balance,0),
       COALESCE(p.advance_balance,0)
FROM wallets_physical wp
LEFT JOIN wallet_balances_projection p ON p.user_id = wp.user_id;
```
`wallets_physical` holds only identity/`locked_balance`/`currency`. **No bucket truth lives in any table.** Two `INSTEAD OF` triggers (`wallets_view_instead_of_insert/update`) redirect writes to `wallets_physical`. **[observed]**

`wallet_balances_projection`: `user_id (pk), withdrawable, float_balance, advance_balance, pending_holds, restricted_held, total_visible, ledger_version, updated_at`. **[observed]**

### Two dead writers — a live documentation hazard
- `sync_wallet_from_ledger()` is an **intentional no-op** whose comment (dated 2026-04-23) claims *"apply_wallet_movement() is now the sole writer to wallets.balance"*. **[observed]**
- **Both** `apply_wallet_movement` overloads are also neutered. The 4-arg version only calls `wallet_route_for_category` for diagnostics (logging to `wallet_unrouted_movements`) then `INSERT INTO wallets_physical (user_id) ... ON CONFLICT DO NOTHING`. The 5-arg version additionally validates `recipient_type` and `assert_routing_compatible`, logging failures to `wallet_routing_violations` with `source:'apply_wallet_movement_v2_neutered'` — the name documents its own neutering. Neither routes a movement into a bucket. **[observed]**
- The **real** cache writer is `tg_refresh_wallet_projection_on_ledger` → `refresh_wallet_projection_for(NEW.user_id)`, fired AFTER INSERT for every `ledger_scope='wallet'` row. **[observed]**
- Consequence: `wallet-cache-sweep/index.ts`'s header comment ("cache mirror updates atomically via `apply_wallet_movement`") is **stale**, and so is `sync_wallet_from_ledger`'s. Two layers of comments point at dead code. **[observed]**

### The lockdown: `enforce_wallet_ledger_only`
No-ops when no bucket column changed; raises `insufficient_privilege` if `wallet.accrual_lock='on'`; otherwise permits the mutation **only** when `current_setting('wallet.sync_authorized', true) = 'true'`, else raises *"Wallet bucket mutation forbidden. Use create_ledger_transaction; balances are derived from the ledger only."* **[observed]**

## 6. Balance Reads and the "Cache Can Only Shrink" Invariant

| Function | Behaviour |
|---|---|
| `get_user_available_balance(uuid)` | Pure cache read of `wallet_balances_projection.withdrawable` |
| `get_user_float_available_balance(uuid)` | `GREATEST(0, float_balance)` from the **strict live** `user_wallet_strict()`; refactored earlier from 6.2s to 11ms |
| `user_wallet_strict(uuid)` / `v_user_wallet_strict` | Ledger-derived truth: `ledger_scope='wallet'`, `classification IN (NULL,'production')` (plus a narrow `system_balance_correction` debit carve-out), rows on/after `wallet_fresh_start_anchors.anchor_at`, bucketed by explicit `wallet_bucket` or `wallet_route_for_category`, **minus** pending `withdrawal_requests` holds (`pending/requested/manager_approved/processing/approved` not yet posted), every bucket clamped `GREATEST(0, …)`. The view also subtracts `restricted_held` for unmatured credits |

**[all observed]**

`wallet_ledger_baseline` and `wallet_fresh_start_anchors` are **tables, not functions**. The anchor marks a zero point after which strict computation begins; the baseline stores a per-user snapshot for write-down/reseed flows. **[observed]**

**Why the cache can only be swept down:** `reseed_anchored_withdrawable` computes `v_delta := GREATEST(0, cached_withdrawable − strict_available)` — structurally non-negative — logs it to `wallet_historical_drift_review`, then posts a balanced `system_balance_correction` / `admin_correction` pair with `skip_balance_check=true`. A cache *below* strict yields `v_delta < 1` → no-op. `admin_reseed_wallet_cache` also floors at 0. There is no code path that raises a cached bucket toward the ledger figure. **[observed]**

### `wallet_route_for_category` has two overloads — this matters
- **IMMUTABLE `(p_category, p_direction)`**: routes the float family (`agent_float_deposit/assignment/topup/funding/used_for_rent/used/settlement`, `agent_landlord_payout`, `rent_disbursement`, `rent_float_funding`) → `float`; `agent_advance_credit`/`salary_advance` credits → `advance_credit`; `agent_advance_repayment`/`salary_advance_repayment`/`debt_recovery` debits → `advance_repayment`; everything else → `withdrawable`. Raises on unsupported direction/category.
- **STABLE `(p_user_id, p_category, p_direction)`**: additionally checks whether the user holds an enabled `agent` role, and forces agent credits in (`cfo_direct_credit, pool_capital_received, partner_funding, supporter_capital, supporter_rent_fund, manager_credit`) into **float**. `wallet_transfer` was **removed from both agent lists on 2026-05-15** because forcing person-to-person transfers into float made transferred money non-withdrawable.

**[observed]** Engineers must know which overload a call site binds to; the agent-aware one silently changes destination buckets.

## 7. Broken Control: `apply_layer_a_writedown`

`apply_layer_a_writedown(p_user_id, p_dry_run=true)` is CFO/manager/service-role gated and reads a table **`phantom_wallet_drift` that does not exist in the live database** (verified by direct query and a cross-schema `pg_class` scan). Any invocation errors at its first `SELECT ... INTO`. Its intended logic — refuse if the user has unspent post-April production credits, else post a balanced `platform_loss_writeoff` admin_correction pair equal to `ABS(LEAST(strict_net,0))`, zero the anchor/baseline, mark the phantom row resolved — is dead. **Do not treat it as a working control.** **[observed]**

Note also that `src/pages/cfo/PhantomDriftDetail.tsx` and `PhantomCorrectionDriftPanel.tsx` read `get_phantom_correction_drift[_detail]` RPCs, which are a *different* mechanism and do work. **[observed]**

## 8. Operations Catalogue

Every FinOps operation funnels through `create_ledger_transaction`. The catalogue below is the observed inventory.

### 8.1 `cfo-direct-credit` — the central engine (998 lines)
Gated to `cfo | manager | super_admin | cto`. Service-role bypasses exist for `system_auto_debit` and `system_requisition_credit` (server-to-server callers). Requires **Routing v2** `recipient_type` (`user` | `operational_wallet`). Categorically **locks** `agent_float_deposit` to float and `agent_commission_earned` to withdrawable. Handles forced reversals via `solvency_bypass_reason` + `skip_balance_check:true`. Also inserts `cfo_debit_obligations` rows with `auto_recover`, where `trg_enforce_bucket_aware_obligation` rejects float-bucket obligations with `auto_recover=true` or a cross-bucket `recovery_source`. **[observed]**

### 8.2 Four functionally duplicate bucket-move tools
`admin-float-to-withdrawable`, `admin-withdrawable-to-float` (with overdraft-filler logic), `finops-wallet-move` (adds a `user_to_user` mode and an error-correction pull back to platform), and `ops-bucket-transfer` all perform the same conceptual user-level bucket reclassification, with **differing auth sets and category names**. `admin-float-to-withdrawable` is `cfo|manager|super_admin|cto`, posts leg 1 `cash_out`/`float`/`operational_wallet` + leg 2 `cash_in`/`withdrawable`/`user` with `skip_balance_check:true`, and is subject to `checkTreasuryGuard`. **This redundancy is the single largest consolidation opportunity in FinOps.** **[observed]**

### 8.3 Recovery and correction tools
`requisition-credit-retry`, `reverse-auto-routed-withdrawal`, `reverse-uncoded-deposits`, `sweep-payout-debits`, `wallet-cache-sweep` (documented as *"the ONLY path that may reduce a cached bucket without a corresponding real-money movement"*, restricted to `cfo|manager|super_admin`), `notify-wallet-reconciliation` (SMS only, batch tag `wallet-reconcile-2026-08-01`, supports `dry_run`). **[observed]**

### 8.4 Mandatory correction pattern
`system_balance_correction` + `classification='admin_correction'` + a `solvency_bypass_reason` is the required combination to pass the negative-ledger triggers. **[observed]**

### 8.5 Mark Not Funded
Agent path: `get_agent_reversible_allocations` → `agent_unallocate_tenant_payment` (in-window self-reversal) or `request_agent_unallocation` (older than 7 days, needs CFO). CFO path: `CFOUnfundingApprovals.tsx` → `cfo_decide_agent_unallocation`, which posts the same balanced reversal. Tables: `agent_unfunding_requests` (0 rows), `agent_tenant_float_reversals` (1 row, carries `commission_clawback`). **[observed]**

## 9. Float Management — Six Distinct Subsystems

All six share `general_ledger` as truth but have separate tables, RPCs and functions. **[all observed]**

### 9.1 Operational float
A **ledger tag, not a table**: `wallet_bucket='float'` + `recipient_type='operational_wallet'`. Company money parked inside individual users' wallets. Top categories inside the bucket: `agent_float_settlement` 6,265 · `rent_payment_for_tenant` 5,992 · `agent_repayment` 1,953 · `agent_float_used_for_rent` 1,161 · `agent_float_deposit` 822 · `agent_float_assignment` 189. **Nothing in the codebase lets a user withdraw from float**; the only exit is the CFO-gated reclass in §8.2. Supporting machinery: `operational_float_audit_log` (961 rows, jsonb before/after allocations), `v_operational_float_tid_duplicates`, `flag_operational_float_tid_duplicates`, `validate_operational_float_allocations`, `register_float_delivery_tid`.

### 9.2 Agent working-capital float
| Table | Rows | Notes |
|---|---|---|
| `agent_float_funding` | 974 | Written by `record-bank-float-transfer` (requires a bank TID; `super_admin|manager|cfo|operations`) and by `fund-agent-landlord-float`; unique-indexed on `rent_request_id` |
| `agent_float_limits` | **0** | Full caps/threshold infrastructure (`float_limit, collected_today, cash_on_hand, daily_txn_limit, is_paused`) exists but is **unpopulated** |
| `agent_float_withdrawals` | 1 | GPS-matched agent→landlord cash-outs (`gps_match`, `gps_distance_meters`) with two-stage review |
| `float_requests` | 198 | Agent-initiated top-ups; `notify-cfo-float-request` fans out the alert |

`assign-agent-float` is gated to `super_admin|manager|cfo|coo|operations`, checks the sender's own balance, posts an `agent_float_assignment` pair and writes `audit_logs`.

### 9.3 Agent-Landlord (LP) float — allocate → payout → reconcile
- **Allocate:** `fund-agent-landlord-float` (423 lines, `cfo|manager|super_admin`) refuses if the rent request is already `funded` (idempotency comment cites incident *"RR d723bc4d, 2026-07-29"* where "Batch: landlord float" double/quadruple-funded), enforces a unique live-allocation guard on `(rent_request_id, source='cfo_disbursement', status IN open/partially_paid)`, posts `rent_disbursement`/`rent_receivable_created` keyed `fund-agent-landlord-float:{rent_request_id}:float`, and pays a flat **UGX 5,000** agent bonus keyed `…:bonus`.
- **Balance is derived, not written.** `credit_float_on_funding()` is now a **no-op stub**: *"RETIRED 2026-07-30: agent_landlord_float.balance is derived from agent_landlord_float_allocations via trg_sync_landlord_float_from_allocation. Crediting here double-counted every CFO funding call."*
- **Payout:** `issue-landlord-payout-otp` (552 lines) → `verify-landlord-payout-otp` → `landlord-payout-disburse` (OTP freshness ≤120s, duplicate-payout block, `get_agent_lp_float_available` where *reserved = balance − in-flight `landlord_payouts`*). The LP float is **reserved, not debited**, at disbursal request; the real debit lands when FinOps' `approve-withdrawal` records the MoMo send. The payout is routed into the merchant queue as a `withdrawal_requests` row carrying `landlord_payout_id`.
- **Apply:** trigger `apply_landlord_payout_to_allocation()` matches the live allocation by `rent_request_id` then `tenant_id`, increments `paid_out_amount`, and stamps `landlord_payouts.allocation_applied_id` so the same payout is never applied twice as it moves through states.
- **Commission:** `post-float-payout-commission` pays 1% of `agent_float_withdrawals.amount`, idempotent on `(source_table, source_id, category='agent_commission_earned')`.
- **Reconcile:** `v_agent_landlord_float_reconciliation` (755 rows) compares the cached balance to `SUM(remaining_amount)` of open/partially_paid/return_pending allocations. Cron `reconcile-agent-landlord-float` (`17 * * * *`) runs `reconcile_agent_landlord_float_all(false, false, 'scheduled_scan','cron')` — **report-only, it does not auto-apply**. Live drift: **13 of 755 agents (1.7%)**.
- `agent_landlord_float_corrections` holds **1,723 rows** — by far the largest correction table on the platform, evidence of prolonged manual firefighting before the 2026-07-30 derived-balance fix.
- `agent_landlord_payouts` (0 rows) is a superseded CFO-approval variant; the live path is `landlord_payouts` (671 rows).

### 9.4 Merchant "float" — does not exist as a balance
There is **no `merchant_float` table**. Merchant agents claim rows from the generic `withdrawal_requests` queue (353 rows carrying `landlord_payout_id`: 348 completed, 6 rejected), surfaced by `MerchantClaimsLog.tsx`. Supporting routines: `get_merchant_float_network_status`, `is_merchant_agent`, `merchant_set_online`, `enforce_no_merchant_agent_auto_debit`, `pay_merchant_agent_referral_bonus`, `notify_merchants_new_withdrawal`.

### 9.5 Landlord payout pipeline
`landlord_payout_otp_challenges` 1,178 · `landlord_payout_otp_events` 2,122 · `landlord_payouts` 671. Status machine: `otp_verified → pending_merchant_payout → pending_finops_disbursement | awaiting_agent_receipt → disbursed | completed`, with `sla_deadline`, `escalated_at/reason`, `attempts`, `last_error`, FinOps fields (`finops_disbursed_by/at`, `finops_momo_reference`), receipt fields, and `allocation_applied_id`. `landlord-payout-sla-monitor` and `submit-landlord-payout-receipt` complete the loop. FinOps UI: `LandlordPayoutsQueue.tsx`.

### 9.6 Recoveries
`agent_unfunding_requests` (0), `agent_tenant_float_reversals` (1), `agent_landlord_float_corrections` (1,723). CFO UI: `CFOAgentOpsFloatSender.tsx`, `AgentFloatManagement.tsx`, `LandlordFloatAllocationsPanel.tsx`, `LandlordFloatReconciliationPanel.tsx`.

## 10. Payroll

`supabase/functions/hr-pay-release/index.ts` (337 lines) is the disbursement engine. **[observed]**

- **Authority is position-based, not role-based**: `hr_pay_is_releaser()` with fallback `hr_pay_is_rule_admin()`. Also gated by `checkTreasuryGuard`.
- The run must be `status='approved'` (else 409). `dryRun:true` computes blockers (`net<=0`, no linked `user_id`) and writes nothing.
- **Idempotency:** claim row in `hr_pay_disbursements` keyed `hrpay:{runId}:{payslipId}` inserted **before** any ledger write; a `23505` is treated as `already_handled`.
- Two balanced legs via `create_ledger_transaction`: `platform/cash_out/salary_payout/recipient_type:'user'` and `wallet/cash_in/salary_payout/recipient_type:'user'`.
- On ledger failure the disbursement row is marked `failed` and the loop continues — **partial-run tolerant, no rollback of already-posted payslips**.
- SMS is sent only **after** a posted disbursement and an `audit_logs` write; Yoola primary → Africa's Talking fallback, every attempt logged to `sms_delivery_log`.

`src/hr/pay/api/workflow.ts` documents that `hr_pay_runs.status` is **never written from the client** — a DB trigger on `hr_pay_run_events` advances it from inserted events (`submitted`/`approved`/`returned`/`locked`). `myPayrollAuthority()` calls `hr_pay_is_preparer/approver/releaser`. **[observed]**

`hr-submit-payroll` gates on `user_roles` (`hr`/`super_admin`) — **a different authority model from `hr-pay-release`'s position check** — and flips `payroll_batches` `draft→submitted` conditioned on `.eq('status','draft')`. **[observed]**

`apply-payroll-growth` (159 lines) has **no visible auth check** (cron/service-role only), uses a `lte('last_growth_at', cutoff-23h)` time cutoff rather than a claim row, posts compounding `system_balance_correction`/`interest_expense` legs with `skip_balance_check:true`, calls `enforce_recipient_routing`, then emits `system_events` `payroll.growth.applied`. `payroll_growth_balances` has **108 rows** (live). **[observed]**

Live state: `hr_pay_runs` 1 `in_review`, 1 `approved`; `hr_pay_disbursements` 26 `posted`; `hr_pay_payslips` 74 historical + 50 current. **`hr_pay_advances` has 0 rows** and no matching edge function — the feature is dormant. **[observed]**

## 11. Employee and Director Requisitions

`requisition-decide` (210 lines): `cfo/super_admin/manager`. CFO can **override the amount** (rounded 2dp) on approval. It snapshots the pre-decision row, short-circuits if `wallet_credit_status='credited'`, resolves the requester by `ilike(email)`, then calls the shared credit engine. **If the credit fails or no profile is found, it performs a full rollback** of `status/approved_by/approved_at/rejection_reason/amount` and sets `wallet_credit_status='failed'`, logging `requisition_approval_rolled_back` and skipping the email. True approve-or-nothing. **[observed]**

`_shared/requisitionWalletCredit.ts` (406 lines) is the shared engine for employee requisitions, director requisitions and retries:
- Unique row in `requisition_wallet_credits` keyed `(source_table, requisition_id)`; a duplicate is either returned as `already_credited` or reused for retry with `attempt_count++`. Never a double credit.
- Credits via raw `fetch` to `cfo-direct-credit` with `system_requisition_credit:true` and a service-role bearer; `recipient_type:'user'`, category `payroll_expense`, `financial_impact:'expense'`.
- On failure: marks both rows `failed`, notifies every `cfo`/`super_admin` via `notifications`, logs `requisition_wallet_credit_failed`.
- On success: notification + email + SMS keyed `req-credit-${sourceTable}-${requisitionId}`.

`requisition-submit` validates `requisition_links` (`is_active`, `expires_at`, `max_submissions`, `revoked_at`), rate-limits **5/hour per IP**, and emits `requisition.submitted`. `requisition-credit-retry` (`cfo/super_admin/manager/ceo`) has a `recover_all:true` bulk mode scanning both requisition tables for `status IN (approved,paid) AND wallet_credit_status='failed'`, limit 50 each. **[observed]**

**Asymmetry to fix:** `director-requisition-action` (`ceo/super_admin/manager`) calls the same shared engine but has **no snapshot/rollback** — a director requisition stays `approved` even when the credit fails. **[observed]**

Live: `employee_requisitions` 8 approved / 2 paid / 2 rejected; `director_requisitions` 17 approved / 1 rejected; `requisition_wallet_credits` **2 credited vs 6 failed**. All six failures read `"Edge Function returned a non-2xx status code"`, dated 2026-07-30 → 2026-08-03, attempt counts 1–3, **never recovered**. This is an open liability: `requisition-credit-retry --recover_all` has evidently not been run against them. **[observed]**

## 12. Standing Orders (`process-scheduled-payouts`)

278 lines. `checkTreasuryGuard` first; optional `payout_id` scoping for single-order runs. **[observed]**

- **Per-cycle idempotency:** if a `scheduled_payout_runs` row with `status='success'` and `ran_at >= payout.next_run_at` exists, skip crediting and only advance `next_run_at`.
- **Category map:** `roi_payout→roi_wallet_credit/roi_expense`; `agent_commission→agent_commission_earned`; `payroll→salary_payout/payroll_expense`; `marketing_expenses`, `research_development`, `operational_expense` → `system_balance_correction`; `correction_credit`→`system_balance_correction` (neutral); `wallet_transfer_out`→`wallet_transfer` (neutral); unmapped falls back to `operational_expense`.
- **`computeNextRun`:** `daily` +1d · `weekly` to `day_of_week` (clamped 1–7d) · `interval` `interval_days` (min 1) · `monthly`/default +1 month.
- Money moves via `cfo-direct-credit` with `system_requisition_credit:true` and a service-role bearer — the same server-to-server mechanism as requisitions.
- **On failure:** writes a `failed` run row and **does not advance `next_run_at`**, so the same cycle retries. On success: best-effort `apply_roi_advance_recovery` keyed `sched-{payout.id}-{YYYY-MM-DD}`, a `success` run row, SMS, then advance.

Live: 6 enabled `scheduled_payouts`; `scheduled_payout_runs` **56 failed vs 1 success**. Every sampled failure is `{"error":"Unauthorized"}` — the historical missing-`system_requisition_credit` bug already fixed; the single success is post-fix. **The failed backlog was never replayed.** **[observed]**

## 13. Recovery and Debt

**`process-debt-recovery` is dead code.** It reads `debt_recovery_cases`, a table that **does not exist** in the live database, matching `SYSTEM_CONTEXT.md`'s own note that it is "inactive". Its cron `process-debt-recovery-daily` is additionally `active=false` and stale. **[observed]**

The live machinery is:
- **`process-credit-draw`** — submission only, **no money moves**; creates `credit_access_draws` `status='pending_cfo'`; blocks a second draw while `active/overdue/pending_cfo` exists; `MONTHLY_RATE=0.33`, `accessFee = amount * (1.33^months − 1)`.
- **`cfo-approve-credit-draw`** — `cfo/manager/super_admin`; `checkTreasuryGuard` on the approve path only (**the reject path is unguarded**); re-validates against `credit_access_limits.total_limit` at approval time; the update is conditioned `.eq('status','pending_cfo')` to kill the double-disbursement race; posts `platform cash_out` / `wallet cash_in` with **explicit `wallet_bucket:'withdrawable'`** — the only function observed setting the bucket explicitly.
- **`process-credit-daily-charges`** — `DAILY_COMPOUND_RATE = 1.33^(1/30) − 1`; deducts from the user first, falls back to the `agent_id`'s wallet for the shortfall; one `credit_draw_ledger` row per draw per day (`deduction_status ∈ full|partial|none`); two separate balanced `agent_repayment` postings.
- **`default_recovery_ledger`**: 600 `open`, 268 `voided_phantom`. **`cfo_debit_obligations`**: 600 `open`, 268 `voided_phantom`. **`credit_access_draws`**: 161 `pending_cfo`, 21 `overdue`, 11 `completed`, 2 `active`. **`credit_draw_ledger`**: 2,036 `none`, 366 `full`, 141 `partial`. **[observed]**
- `send-recovery-notice` is unrelated to debt cases — it is a manual SMS backfill for float-recovery notices.

## 14. Security Model

### 14.1 Roles and the three inconsistent staff sets
`app_role` enum (24 values): `tenant, agent, landlord, supporter, manager, ceo, coo, cfo, cto, cmo, crm, employee, operations, super_admin, hr, senior_agent, sub_agent, admin, tenant_ops, landlord_ops, agent_ops, financial_ops, partner_ops, access_admin`. **[observed]**

| Helper | Members |
|---|---|
| `has_role(_user_id,_role)` | the atomic `EXISTS` primitive, requires `enabled=true` |
| `is_ops_role` | `manager, super_admin, coo, operations` |
| `is_withdrawal_staff` | `manager, operations, cfo, coo, super_admin, cto` |
| `ops_caller_is_ops` | + `financial_ops, agent_ops, partner_ops, tenant_ops, landlord_ops, admin, cmo, ceo` |
| `agent_ops_directory_guard` | raises `not_authorized` unless ops or `manager/cfo/ceo/coo/cto/super_admin` |
| `is_welile_staff` | referenced by `director_requisitions` RLS; not in the canonical inventory |
| `hr_pay_is_{rule_admin,preparer,approver,releaser,rule_reader,own_staff}` | a **separate** maker-checker chain for payroll |

**Risk:** three different definitions of "finance staff" exist. `financial_ops` is in `ops_caller_is_ops` but **absent from `is_withdrawal_staff`**, so financial_ops cannot update `withdrawal_requests` via RLS. Adding a role to one helper does not propagate. **[observed]**

### 14.2 RLS highlights (232 policies inventoried)
- `general_ledger` — deny-all writes (§3).
- `withdrawal_requests` — users insert own (or proxy agents with an active assignment); `is_withdrawal_staff()` may update **any**; users may cancel only their own `pending`; no DELETE policy.
- `credit_access_limits` — explicit **`Deny direct credit limit updates`** (`UPDATE qual=false`); the only client write is a self-INSERT where every field equals the fixed starter defaults (UGX 20,000 base, zero bonuses).
- `credit_draw_ledger` — `INSERT with_check = true` for any authenticated user: the **widest INSERT check found on a finance-adjacent table**.
- `scheduled_payouts` — full CRUD to `cfo`/`super_admin` only.
- `pending_wallet_operations` — `manager` only (narrower than cfo!).
- `audit_logs` — INSERT self-attributed (`auth.uid()=user_id`, so a client cannot forge another actor); SELECT `manager`/`ceo` only (**cfo and coo excluded** — they use `get_cfo_ledger_trail`).
- `system_events` — INSERT `with_check=true` (open append-only telemetry); SELECT `super_admin/manager/ceo/cfo/coo`.
- `deposit_decision_audit`, `deposit_guardrail_audit` — **SELECT-only; no client write policy exists at all** (deny by omission; SECURITY DEFINER writes only).
- `shadow_audit_logs` — **`ALL qual=false`, deny-all to everyone**, including executives. Strongest integrity guarantee on the platform.
- `hr_pay_bank_secrets` — SELECT-only to `hr_pay_is_rule_admin()`.

**[all observed]**

### 14.3 Session flags and break-glass
| Function | Gate | Verdict |
|---|---|---|
| `begin_ledger_maintenance` / `end_ledger_maintenance` | `cfo`/`manager`, reason ≥10 chars, window ≤240 min, both open and close write `audit_logs` | Well-guarded |
| `begin_ledger_migration` | `cfo/manager/super_admin`, validates all params, double-logs to `audit_logs` + `system_events`; sets `ledger.migration_bypass` | Guarded, but see below |
| `begin_wallet_accrual_lock` / `end_wallet_accrual_lock` | **none**; PUBLIC/anon/authenticated EXECUTE; `set_config(..., is_local=false)` = session-persistent | **P0 — platform-wide wallet freeze by any caller** |
| `admin_reseed_wallet_cache` | **none**; anon + authenticated EXECUTE; sets `wallet.sync_authorized='true'` and overwrites balances | **P0 — arbitrary money write** |
| `admin_purge_table_refs` / `admin_purge_user_dependencies` | EXECUTE limited to `postgres` + `service_role` | Acceptable |

**GUC mapping resolved:** `ledger.bypass_guard` is read by `enforce_ledger_rpc_only`; `ledger.migration_bypass` is read by `enforce_wallet_scope_requires_user` and set by `begin_ledger_migration`. They are **two different flags guarding two different triggers** — not the dead-code mismatch it appears to be, but the naming is a trap. `ledger.bypass_guard` has **no role check at its read site**; whoever sets it is trusted implicitly. **[observed]**

### 14.4 Approval matrix
| Operation | Gate |
|---|---|
| Direct credit | No generic "credit anyone" RPC; ~15 narrow `credit_*` SECURITY DEFINER functions, one per bonus/fee type |
| Direct debit | Legacy `wallet_deduction` hard-blocked; replacement is `cfo-direct-credit` + `cfo_debit_obligations` (`manager/cfo/super_admin/cto`) |
| Withdrawal | Insert validated by two triggers; stage chain `pending → manager_approved → cfo_approved → fin_ops_approved` enforced **in the `approve-withdrawal` Edge Function, not in RLS** |
| Payroll release | `hr_pay_is_releaser()` or rule_admin — an approver alone **cannot** release funds |
| Employee requisition | `cfo/super_admin/manager` |
| Credit draw | `manager/coo/cfo/super_admin` + `cfo-approve-credit-draw` |
| Float allocation | `manager/cfo/super_admin` (+`operations` read); funding requires `approved`/`coo_approved` |

**Architectural finding:** RLS enforces *coarse* membership ("are you finance staff at all"); *sequencing* lives in Edge Functions. A holder of direct PostgREST credentials with a staff role could skip approval stages the UI enforces, because `is_withdrawal_staff()` permits updating any `withdrawal_requests` row to any status. **[observed / partially inferred]**

## 15. Withdrawal Guard Triggers

| Trigger | Rule | Exemptions |
|---|---|---|
| `enforce_kyc_withdrawal_cap` | Accounts <30 days old with no advance / prior completed withdrawal / collection history are capped at **UGX 50,000/day** (or a per-user KYC override); `frozen` accounts are blocked outright via `get_kyc_effective_limits` | landlord-payout and proxy-partner withdrawals |
| `enforce_withdrawal_ledger_match` | Rejects `amount > get_user_available_balance()` (special commission calc for cashout-commission withdrawals); failures logged to `withdrawal_attempt_failures` | `landlord_payout_id IS NOT NULL` (float already deducted upstream) |

**[observed]** Note the "graduated" carve-out is the cap's real attack surface: an actor who can cause a `field_collections` row to exist may graduate an account out of the 50k limit. Not proven exploitable — flagged.

## 16. Reconciliation and Drift Estate

| Object | Kind | Rows |
|---|---|---|
| `ledger_balance_pivot` | table (fed by `trg_ledger_pivot_apply`) | 167,805 |
| `ledger_balance_pivot_candidate` | staging | 167,769 |
| `ledger_balance_pivot_2026_08_01_backup` | snapshot | 30,786 |
| `wallet_pivot_drift_view` / `v_pivot_drift` | views (duplicates) | 56,127 each |
| `agent_landlord_float_corrections` | table | **1,723** |
| `ledger_reconciled_tids` | table | 6,620 |
| `wallet_negative_reconciliation_log` | table | 486 |
| `wallet_routing_v2_corrections` | table | 146 |
| `finance_anomaly_scans` / `_alert_states` / `_alert_config` | tables | 51 / 12 / 1 |
| `credit_limit_reconciliation_alerts` | table | 22 |
| `deposit_match_alerts` | table | 112 (**106 unresolved**) |
| `deposit_bridge_gap_alerts` | table | 5 |
| `agent_capability_ops_dead_letters` | DLQ | 4 (**all 4 unresolved**) |
| `email_credit_idempotency` / `gmail_dedup_audit` | dedup guards | 495 / 3,521 |
| `ledger_anomaly_incidents` / `_isolations` | tables | 1 / 1 |
| `wallet_routing_violations`, `wallet_projection_drift_alerts`, `wallet_overdraw_events`, `wallet_unrouted_movements`, `bulk_payout_stuck_alerts`, `cfo_threshold_alerts`, `email_payout_match_attempts`, `withdrawal_attempt_failures`, `settlement_reconciliation_ledger`, `managed_proxy_roi_routing_violations` | integrity tables | **0** |
| `phantom_wallet_drift` | **does not exist** | n/a |

**[all observed]** None of these objects carry a DB `COMMENT`, so purpose is inferred from definition and usage. Zero rows means *observed clean today*, not *cannot fire*.

## 17. Reporting

| Report | Source | Schedule |
|---|---|---|
| `generate-daily-wallet-report` → `daily_wallet_reports` (9 rows, latest 2026-08-03) | `compute_wallet_report` RPC; UI `DailyWalletReportsPanel.tsx` | Daily 21:00 UTC = **00:00 EAT** |
| `daily-wallet-inflows-report` | ledger/wallet tables | Daily 21:00 UTC |
| `DailyCashPositionReport.tsx` | `get_platform_cash_summary`, `get_wallet_totals`, `rent_requests` | on demand |
| `LiquidityForecastPanel.tsx` | withdrawable across all wallets + ROI due/day, 7–60 day horizon | on demand |
| `HouseListingCommissionReport.tsx` | `generate_house_listing_commission_report` | on demand |
| `merchant-cashout-daily-report` (×2) + `generate-daily-merchant-commission` | merchant queue | daily |
| `WithdrawalHistoryStatement.tsx` | `get_withdrawal_history` | on demand |
| `UserWalletStatementsPanel.tsx` | per-user buckets + landlord float + advances | on demand |
| `useFinancialStatements` (`src/hooks/useFinancialStatements.ts`) | consumed by `InvestorReportPage.tsx`, `FinancialStatementsPanel.tsx`, drill map in `financialStatementsDrillMap.ts` | on demand |
| Persona dailies | `agent-ops-`, `agent-growth-`, `daily-cto-`, `daily-cmo-users-`, `daily-landlord-ops-report` | daily |

**`agent_daily_commission_reports` has 0 rows** — either deprecated or never fed. **[observed]**

`CFOActionsLog.tsx` is deliberately **ledger-derived, not action-string-derived**: it reads `get_cfo_ledger_trail`, one row per `transaction_group_id`, so *"every cash movement that posts to the ledger appears here automatically; there is no allow-list of action strings to maintain."* This makes the CFO audit view impossible to under-populate by forgetting to log an action. **[observed]**

## 18. Cron Fleet and Health

`cron.job` is **permission-denied** to ordinary roles; the SECURITY DEFINER RPC **`cron_jobs_health()`** is the supported introspection path and returns `{jobname, schedule, active, last_run_at, last_status, is_stale}`. `CronJobsHealthPanel.tsx` surfaces it, flagging anything not run in >24h with the warning *"Agent commission, debt recovery, ROI accrual and other automations may be silently frozen."* **[observed]**

**Stale jobs, live (11; 9 of them `active=false`):**

| Job | Schedule | Active |
|---|---|---|
| `process-debt-recovery-daily` | `0 6 * * *` | **false** |
| `daily-recalculate-credit-limits` | `30 5 * * *` | **false** |
| `check-agent-liquidity-hourly` | `0 4 * * *` | **false** |
| `refresh-financial-summaries-daily` | `0 3 * * *` | **false** |
| `process-promissory-deductions-daily` | `0 6 * * *` | **false** |
| `partner-ops-automation-daily` | `0 7 * * *` | **false** |
| `refresh-daily-stats` | `0 2 * * *` | **false** |
| `vacancy-alerts-daily` | `0 9 * * *` | **false** |
| `cleanup-old-system-events` | `0 3 * * *` | **false** |
| `semrush-brand-tracker-weekly` / `weekly-database-backup` | weekly | true (stale by the >24h rule only — expected for weeklies) |

**Healthy money-critical jobs (`succeeded`):** `deposit-bridge-worker-30s` (30s), `bridge-gap-alert-notify` & `deposit-bridge-gap-detector-5m` & `detect-deposit-guardrail-alerts` (5m), `auto-reject-unmatched-deposits` & `deposit-match-alert-notify` & `detect-credit-limit-drift-15min` & `detect-sms-verification-failures` (15m), `business-advance-stage-reminders` (30m), `daily-credit-charges` & `auto-charge-wallets-daily` & `auto-process-supporter-roi` (06:00), `daily-advance-deductions` (14:50), `auto-apply-pending-topups-6pm` (15:00), `agent-ops-daily-report-1800-eat`, `apply-scheduled-portfolio-renewals` (21:00), `daily-wallet-inflows-report` (21:00), `business-advance-daily-compounding` & `auto-close-fully-repaid-rents` (23:00), `apply-payroll-growth-daily` (00:00), `reconcile-agent-landlord-float` (`17 * * * *`). **[observed]**

**Caveat:** `cron.schedule` upserts by name and several jobs were rescheduled across migrations (`expire-cash-deposit-codes`, `sweep-agent-advance-recovery`, `email-auto-create-deposits-24h`), so migrations alone under-represent the live fleet — the platform documents ~98 jobs while only ~33 `cron.schedule(` call sites exist in migrations, because cron `net.http_post` bodies embed project URLs/keys and are inserted directly rather than committed. **[observed]**

## 19. Ranked Gap Register

| # | Severity | Finding | Evidence | Suggested remedy |
|---|---|---|---|---|
| 1 | **P0** | `admin_reseed_wallet_cache` — SECURITY DEFINER, no role check, EXECUTE to `anon`+`authenticated`, defeats `enforce_wallet_ledger_only` and overwrites any wallet | §14.3 | `REVOKE EXECUTE FROM anon, authenticated`; add a `has_role(auth.uid(),'cfo'/'super_admin')` guard and an `audit_logs` write |
| 2 | **P0** | `begin/end_wallet_accrual_lock` — no authz, PUBLIC EXECUTE, session-persistent `wallet.accrual_lock` freezes all wallet mutation | §14.3 | Revoke from PUBLIC; gate to cfo/manager; make the flag transaction-local |
| 3 | **P1** | 6 finance crons `active=false` and stale: debt recovery, credit-limit recalc, agent liquidity, financial summaries, promissory deductions, partner-ops | §18 | Decide per job: re-enable or formally retire and delete the function |
| 4 | **P1** | 6 `requisition_wallet_credits` stranded `failed` since 2026-07/08; approvals rolled back but never replayed | §11 | Run `requisition-credit-retry {recover_all:true}`; alert on `failed` age >24h |
| 5 | **P1** | `ledger.bypass_guard` break-glass has no role check at its read site | §14.3 | Require a reason + role assertion in every setter; alert on `ledger_guard_bypass` audit rows |
| 6 | **P1** | Approval *sequencing* is Edge-Function-only; `is_withdrawal_staff()` lets any staff row set any withdrawal status via PostgREST | §14.4 | Add a BEFORE UPDATE stage-transition trigger on `withdrawal_requests` |
| 7 | **P1** | `process-debt-recovery` reads a non-existent `debt_recovery_cases`; `apply_layer_a_writedown` reads a non-existent `phantom_wallet_drift` | §7, §13 | Delete both, or create the tables — do not leave them presenting as live controls |
| 8 | **P2** | Four duplicate bucket-move Edge Functions with divergent auth sets and categories | §8.2 | Consolidate on `finops-wallet-move`; make the others thin deprecating shims |
| 9 | **P2** | Three inconsistent "finance staff" helpers; `financial_ops` cannot update `withdrawal_requests` | §14.1 | Collapse into one `is_finance_staff()` with an explicit matrix |
| 10 | **P2** | `credit_draw_ledger` INSERT policy is `with_check = true` for any authenticated user | §14.2 | Restrict to service role / SECURITY DEFINER |
| 11 | **P2** | `director-requisition-action` lacks the rollback that `requisition-decide` has | §11 | Port the snapshot/rollback block |
| 12 | **P2** | 13 of 755 agents in LP float drift; the reconcile cron is **report-only** | §9.3 | Review the 13, then consider `p_apply=true` with a bounded delta |
| 13 | **P2** | 106 unresolved `deposit_match_alerts`, 4 unresolved capability DLQ rows | §16 | Add an aging SLA + dashboard tile |
| 14 | **P3** | Stale comments naming two dead writers (`apply_wallet_movement`, `sync_wallet_from_ledger`) as the cache authority | §5 | Correct comments to name `refresh_wallet_projection_for` |
| 15 | **P3** | `agent_float_limits` (0 rows) and `hr_pay_advances` (0 rows) — built, unused | §9.2, §10 | Adopt or remove |
| 16 | **P3** | `agent_daily_commission_reports` empty; `email_payout_match_attempts` empty despite a mounted panel | §16, §17 | Confirm the feeder job exists |
| 17 | **P3** | `wallet_pivot_drift_view` and `v_pivot_drift` are duplicate 56,127-row views | §16 | Drop one |
| 18 | **P3** | 56 failed `scheduled_payout_runs` (historical `Unauthorized`) never replayed or purged | §12 | Backfill or archive so the failure rate stops masking new faults |
| 19 | **P3** | No DB `COMMENT` on any reconciliation object; `ledger.migration_bypass` vs `ledger.bypass_guard` naming trap | §14.3, §16 | Add comments; rename one GUC |

---

### Verification notes
Written from six parallel read-only research passes plus direct `psql` verification of every number quoted. Items that could **not** be verified and remain open: the full line-by-line stage-transition logic inside `approve-withdrawal` (2,500+ lines, sampled only); the bodies of ~15 `credit_*` bonus functions; whether the "graduated" KYC carve-out is exploitable; and the portfolio-topup approval path, which appears only as a `system_events` enum value.
