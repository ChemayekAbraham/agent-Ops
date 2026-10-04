# Welile — Agent System Architecture

**Definitive Agent System Reference Manual**
Audience: engineers, operations, finance, auditors, future AI assistants.
Companion document: `docs/FINANCIAL_SYSTEM_ARCHITECTURE.md` (ledger/wallet invariants are defined there and assumed here).

> Method: reverse-engineered from the live Supabase schema (452 tables, ~1,074 functions, of which **74 agent-scoped tables/views** and **~230 agent-scoped RPCs**), all `supabase/functions/*` edge functions, `src/components/agent/*`, `src/pages/agent/*`, `src/components/executive/AgentOpsDashboard.tsx`, and migration history. Where a claim is an inference rather than an observed definition it is marked **(inferred)**.

---

## 1. Executive Summary

The Agent Module is the field-force layer of Welile. Agents are the humans who acquire landlords and houses, register tenants, post rent requests, disburse company money to landlords, collect daily rent, and (for merchant agents) settle user cash-outs from their own mobile-money balance.

Five things define the module:

1. **Agents never hold authoritative balances.** Everything an agent "has" is a projection of `general_ledger`. `wallet_balances_projection` (buckets: `withdrawable`, `float_balance`, `advance_balance`) and `agent_landlord_float.balance` are caches maintained by triggers.
2. **Two distinct floats.** *Operational float* (`wallet_bucket='float'`) is company money in the agent's wallet. *Landlord-Payout (LP) float* (`agent_landlord_float`) is money ring-fenced per rent request, derived from `agent_landlord_float_allocations`.
3. **Earnings are event-driven and idempotent.** 10% of rent collected (8%/2% split when a recruiter override applies), 1% on merchant transactions, plus flat bonuses (UGX 100 location capture, 2,000 listing, 2,000 LC verified, 5,000 landlord/rent-funded, 10,000 placement). Every credit carries an `idempotency_key`.
4. **Credit is single-slot.** An agent may hold exactly one live advance; growth happens through **top-ups**, not new advances. Missing a day creates **arrears**, it never compounds principal.
5. **Enforcement lives in the database.** ~230 `SECURITY DEFINER` RPCs plus 34 ledger triggers and dozens of column-level guards mean the client cannot mint money, self-report repayment, inflate principal, or edit protected fields.

**Known open risks (as of this document):** ~UGX 22M historical drift from 8,558 legacy `agent_commission_earned` rows lacking platform-side balancing legs; three failing cron jobs (`sweep-agent-advance-recovery`, `expire-stale-bonus-restrictions`, `recalculate-trust-scores-nightly`); a cadence conflict for `sweep-agent-advance-recovery` (15-min vs daily) across migrations; and two divergent access-fee formulas (simple vs compound).

---

## 2. Business Model

| Role | What they do | How they earn |
|---|---|---|
| **Agent** | Recruits landlords, lists houses, registers tenants, posts rent requests, pays landlords from float, collects daily rent | 10% of rent collected + flat event bonuses |
| **Senior agent** | Same, with higher per-tenant caps and larger float limits | Same, plus recruiter overrides |
| **Sub-agent** | Recruited by a parent agent; auto-verified at DB level | 8% of own collections (2% goes to parent) |
| **Merchant agent** | Cash-out only; pays users from own MoMo float | Principal + 0.5% commission, ~1% on merchant transactions |
| **Proxy/supporter agent** | Withdraws on behalf of partners | No commission; strictly gated |

Welile's unit economics: rent is funded to the landlord up-front; the tenant repays principal + a 33% access fee over a cycle. The agent's 10% is a cost of collection paid out of realised repayments, which is why commission **accrues** on allocation and **releases** on ledger-verified repayment.

---

## 3. Agent Identity & Lifecycle

States: `invited → registered → verified → active → (restricted | frozen) → dormant`.

- **Registration.** Self-signup or via referral link. `referralAttribution.ts` persists the referral code for 60 days so attribution survives app reloads and OTP detours.
- **Sub-agent registration** is **auto-verified at the database level**; the parent-agent invite flow still requires an acceptance token, so an invite is not a grant of capability.
- **Name verification.** `NameCompletionGate` requires ≥2 name tokens and rejects random-character strings before an agent can transact.
- **Phone verification.** `PhoneCollectionGate` + OTP; `MobileMoneyNameCard` captures the exact name shown on the agent's MoMo account so payouts reconcile against telecom statements.
- **Freeze.** `AgentFrozenGate.tsx` renders a full-screen red legal banner. Server-side, `enforce_agent_full_freeze` blocks INSERTs on `agent_collections`, `agent_receipts`, `agent_tasks`, `agent_visits`, `field_collections`, `offline_collection_submissions`, `property_viewings` — one trigger reused across seven tables.
- **Login-side revocation.** `revoke_agent_management_on_login` on `users` strips stale management privileges at session start.

## 4. Capabilities & Tiering

`agent_capabilities` enforces **11 fixed capabilities** (list-house, register-tenant, post-rent-request, collect-rent, pay-landlord, cash-out, order-merchandise, invite-sub-agent, capture-location, request-advance, transfer-tenant). Capability changes are applied asynchronously:

- `agent_capability_ops_jobs` / `_job_batches` — queued grants/revokes.
- `process-agent-capability-jobs` edge function, driven by a **30-second cron**.
- `agent_capability_ops_undo_snapshots` — rollback state for bulk operations.
- `agent_capability_ops_dead_letters` — failed jobs retained for manual replay.
- `sync_cashout_agent_capability` trigger on `cashout_agents` keeps merchant capability in step with merchant status.

`agent_tier` + `agent_tier_capabilities` drive per-tier ceilings. Tier assignment is scored, not manual (see §7).

## 5. Dashboard & Navigation Architecture

- `AgentHubTabs.tsx` — bottom tab bar. Supports a **restricted mode** so cash-out-only merchant agents see a reduced surface. The "Sub-Agents" entry was replaced by **Service Center** (`Store` icon).
- `AgentMenuDrawer.tsx` — full action catalogue, with explicit merchant-blocking filters.
- `/agent/service-center` — purchase items, view/suspend sub-agents, transfer tenants; backed by `get_agent_service_center()` and `SubAgentDetailSheet.tsx`.
- `UnifiedWalletHeroCard.tsx` — collapsible-by-default wallet card (framer-motion liquid morph).
- `floating-nav.tsx` — detached pill navigation shell shared across Tenant/Agent/Funder/Owner personas.
- Staff side: `src/components/executive/AgentOpsDashboard.tsx` hosts **35+ operational panels** grouped in a re-organised sidebar, fed by a single overview RPC to avoid N+1 fetches.

Security note: `LedgerEntryDetailDrawer.tsx` hides **Running Balance** from agents and end users; only finance/audit roles see it.

---

## 6. Earnings & Commission Engine

**Rates.**

| Event | Amount |
|---|---|
| Rent collected | 10% of collection |
| Rent collected, sub-agent with recruiter override | 8% agent / 2% parent |
| Merchant transaction | 1% |
| Merchant cash-out settlement | 0.5% + principal reimbursement |
| Contact location captured | UGX 100 (idempotent per contact, key `loc:<target_id>`) |
| House listing approved | UGX 2,000 |
| LC verified | UGX 2,000 |
| Landlord verified | UGX 5,000 |
| Rent request funded | UGX 5,000 (`RENT_FUNDED_BONUS`) |
| Tenant placement | UGX 10,000 |

**Accrual vs release.** Commission accrues when an allocation is created and releases to `withdrawable` only when a matching ledger repayment leg exists. `agent_earnings` carries a **"Deny direct earnings inserts"** RLS policy — the table is server-write only.

**Reversal.** `agent_unallocate_tenant_payment` claws back the 10% on both wallet and platform legs, within a 7-day window, once only (unique on `agent_tenant_float_reversals.original_transaction_group`).

**Arrears interception.** `recover_agent_arrears_from_credit()` intercepts new earnings and applies them FIFO to advances in arrears before they become withdrawable.

**Known legacy issue.** 8,558 `agent_commission_earned` rows predate the balanced-pair requirement and lack platform-side legs → ~UGX 22M reported imbalance. Historical only; new writes go through `create_ledger_transaction`.

## 7. Trust, Eligibility & Scoring

- `agent_visits` is the geo-attestation anchor; `agent_collections.visit_id` and `payment_tokens.visit_id` reference it.
- `agent_capture_contact_location()` writes address hierarchy to `profiles`, optionally inserts a visit, calls `capture_trust_signal()` (exception-swallowed, non-blocking), pays UGX 100 idempotently, logs `system_events`.
- `capture_trust_signal()` writes `agent_visits` + `venue_visits` + `audit_logs`, then `recompute_trust_score(tenant)`.
- `v_agent_daily_eligibility` exposes `expected_daily`, `paid_today`, `paid_yesterday`, `today_pct`, `yesterday_pct`, `effective_pct`; snapshotted nightly by `snapshot-agent-daily-eligibility` (`30 0 * * *`).
- `agent_per_tenant_max()` — tiered per-tenant lending cap from 7-day responsiveness: 0 active tenants → 500,000 (Starter); ≥0.70 → 6,000,000; ≥0.40 → 3,000,000; ≥0.10 → 1,000,000; else 0.
- `enforce_agent_daily_eligibility` and `enforce_agent_rent_request_capacity` triggers on `rent_requests` block posting beyond capacity.

**Operational trap:** "Today's Capacity" is coupled to the `agent_collections` table. If an agent collects but the row isn't written, the agent appears idle and loses capacity.

---

## 8. Float Architecture — Two Distinct Inventories

### 8.1 Operational float
`wallet_balances_projection.float_balance` (`wallet_bucket='float'`) — company money the agent may spend in the field. Funded by:

| Edge function | Auth | Effect |
|---|---|---|
| `assign-agent-float` | super_admin, manager, cfo, coo, operations | Balanced `agent_float_assignment` wallet pair + `audit_logs` |
| `record-bank-float-transfer` | cfo, manager, super_admin | Requires `bank_reference` (TID); `agent_float_funding` row + ledger pair |
| `transfer-to-float` | agent role | Backend-authority: client sends only `{amount}`; server validates withdrawable, posts `wallet_deduction`/`agent_float_deposit` with `idempotency_key = float-transfer-<uid>-<ts>` |
| `admin-withdrawable-to-float` / `admin-float-to-withdrawable` | cfo/manager/super_admin/cto + `checkTreasuryGuard` | Bucket reclassification with explicit `wallet_bucket`/`recipient_type` |

`admin-withdrawable-to-float` pre-checks float net; refuses with `FLOAT_OVERDRAWN` (409) unless `acknowledge_float_overdraft:true`, in which case it seeds an `admin_correction` overdraft-fill leg (`solvency_bypass_reason:'admin_correction_seed'`) first. Post-write it re-reads `wallets`, logs `wallet_overdraw_events` and returns 500 if any bucket went negative.

### 8.2 Landlord-Payout (LP) float
- **Source of truth:** `agent_landlord_float_allocations` (`allocated_amount`, `paid_out_amount`, `remaining_amount` generated, status `open|partially_paid|fully_paid|cancelled|return_pending`), with unique index `idx_alfa_one_live_per_request_source` — **one live allocation per (rent_request_id, source)**.
- **Cache:** `agent_landlord_float.balance`, since 2026-07-30 **never written directly**; derived by `trg_sync_landlord_float_from_allocation`. Backstop `CHECK (balance >= 0)`.
- **Available:** `get_agent_lp_float_available()` = `GREATEST(0, balance − SUM(landlord_payouts WHERE status IN ('otp_verified','pending_merchant_payout')))`.
- **Funding:** `fund-agent-landlord-float` (CFO/manager/super_admin). Requires rent request `approved`/`coo_approved`; returns 409 `already_funded` if already funded (guard added after the 2026-07-29 quadruple-funding incident on RR `d723bc4d`). Order: create allocation → bump `total_funded` → set status `funded` → `agent_float_funding` row → ledger pair `rent_disbursement`/`rent_receivable_created` with key `fund-agent-landlord-float:<id>:float` → UGX 5,000 agent bonus + notification + email + manager push.

### 8.3 Limits, guards and monitoring
- `agent_float_limits`: `float_limit`, `collected_today`, `daily_txn_limit` (default **5,000,000**), `low_threshold_pct` 20, `critical_threshold_pct` 10, `is_paused`, `cash_on_hand`. Threshold enforcement appears to be dashboard-side alerting; no hard DB trigger for `daily_txn_limit` was located **(inferred)**.
- `enforce_no_negative_wallet_ledger()` — the central overdraft guard. Fires on `ledger_scope='wallet'` + `direction IN ('cash_out','debit')`:
  - float debits → `NEGATIVE_FLOAT_BLOCKED` if projection float < amount (falls back to `v_user_wallet_strict` when projection row missing);
  - withdrawable debits → `LEDGER_BACKING_REQUIRED` using `get_user_available_balance()` plus active withdrawal holds;
  - `admin_correction` / `platform_loss_writeoff` require `solvency_bypass_reason`; `other_with_note` needs a ≥30-char description; `system_balance_correction` bypasses entirely.
- **Monitoring:** `v_agent_landlord_float_reconciliation` (cached vs recomputed), `agent_landlord_float_corrections`, `v_operational_float_tid_duplicates`, `operational_float_audit_log`, `agent_rebalance_records`, `agent_unfunding_requests`, `wallet_overdraw_events`. Hourly cron `reconcile-agent-landlord-float` (`17 * * * *`).

## 9. Float Withdrawal & Payout Pipeline

`agent_float_withdrawals`: GPS-matched payouts to landlords (`agent_latitude/longitude`, `landlord_latitude/longitude`, `gps_match`, `gps_distance_meters`), staged `pending_agent_ops → agent_ops_approved/rejected → cfo_approved/rejected → completed`, with OTP fields.

**Landlord payout flow:** agent selects landlord → taps Withdraw → OTP sent to the landlord's phone → verified → payout enters `pending_merchant_payout` → merchant dispatch settles it. `agent-withdrawal` explicitly blocks debiting a `supporter` wallet (`PROXY_CUSTODY_BLOCKED`) to force the proper proxy path.

---

## 10. Tenant Management

- **Auto-assignment.** `auto_assign_landlord_to_agent()` upserts `agent_landlord_assignments` on any `rent_requests` row where both `agent_id` and `landlord_id` are present (`ON CONFLICT DO NOTHING`).
- **Rent request lifecycle RPCs** (all `SECURITY DEFINER`, all assert `auth.uid() = agent_id`):
  - `agent_cancel_rent_request(id, reason)` — reason ≥10 chars; only `pending|approved|rejected` and not yet funded/disbursed; sets `deleted_by_agent`.
  - `agent_resubmit_rent_request(id, patch, note)` — note ≥10 chars, only from `rejected`, `reopen_count < 5`; recomputes `access_fee`/`total_repayment`/`daily_repayment` (33%).
  - `agent_delete_rejected_rent_request(id, reason)` — reason ≥10 chars.
  - `agent_respond_payment_edit(edit_id, response, note)` — `disputed` requires ≥5-char note and reverts `rent_amount`/`agent_landlord_payouts.amount` to `old_amount`.
- **Tamper guard.** `guard_rent_request_agent_updates()` resets protected fields (`approved_by/at`, `funded_at`, `disbursed_at`, `fund_routed_*`, `manager_verified*`) to `OLD` on every agent update, and allows `amount_repaid` to advance / status → `repaying|completed` **only** when a same-transaction (`gl.xmin::text::bigint = txid_current()`) `agent_float_used_for_rent` float debit matches the delta. Agents cannot self-report repayment.
- **Status & priority.** `agent_set_rent_payment_status(id, status, reason)`: `not_paying` needs ≥10-char reason, suspends the house listing (`suspended_tenant_id` set, `tenant_id` cleared, `status='available'`), clears `landlords.tenant_id`, bumps `ops_inbox_events` (`bucket='at_risk'`), fires `capture_trust_signal`; `paying` restores.
- **Reassignment.** `agent_ops_reassign_idle_tenant(id, new_agent, reason)` — agent_ops/coo/manager/super_admin; reason ≥10 chars; target agent must have collected in the last 3 days; writes `tenant_reassignment_audit`, clears `tenant_idle_states`, emits `tenant.reassigned`.
- **Sub-agent transfer.** `agent_request_subagent_tenant_transfer()` — caller must be verified parent of both sides (`agent_subagents.status='verified'`); no duplicate pending transfer; row in `subagent_tenant_transfers` (`pending`). Reviewed by `admin_decide_service_center_request` (`is_service_center_reviewer` gate; rejection requires reason).
- **Auto-closure.** `auto_close_fully_repaid_rents()` moves `funded|repaying` rows with `amount_repaid >= total_repayment > 0` to `completed` / `agent_payment_status='completed_auto'`.
- **Verification messaging.** `AgentRentRequestDialog.tsx` shows "Landlord {Name} is not yet verified…" instead of hard-blocking.

## 11. Collections & Allocation

- `agent_allocate_tenant_payment()` — thin wrapper asserting `auth.uid() = p_agent_id` and agent/senior_agent/sub_agent role, delegating to `agent_allocate_tenant_payment_internal`.
- `agent_unallocate_tenant_payment()` — reason ≥10 chars, 7-day window, landlord match verified, 4-leg reversal (float back, landlord debit, commission clawback ×2), rolls back `amount_repaid`/`status`, writes `agent_tenant_float_reversals` + `audit_logs`.
- `agent_reverse_tenant_allocation()` — reason ≥5 chars, own `agent_collections` rows tagged `float allocation`, idempotent via `[REVERSED]` marker, inserts a **negative** `repayments` row.
- `agent-deposit` — validates the agent's **float** (not total wallet) via `get_agent_split_balances`, credits the tenant, pays 10% via `creditFlatAgentCommission` (key `agent-collection-comm-<ref>`, duplicate-tolerant).
- Parallel manual/offline paths: `field_collections`, `submit-offline-collection`, `manual-collect-rent`, `offline_collection_submissions`.

---

## 12. Agent Advances (Credit)

**Tables.** `agent_advance_requests` (33 cols) → `agent_advances` → `agent_advance_ledger`, `agent_advance_topups`, `advance_fee_config`.

**Approval chain.** `pending → agent_ops_approved → tenant_ops_approved → landlord_ops_approved → coo_approved → cfo_disbursed → active → completed` (`rejected`/`defaulted` terminal). Per-stage `reviewed_by_*`, `*_reviewed_at`, `*_notes`; plus `approved_by_coo`, `paid_by_cfo`, `cfo_approved_by`, `cfo_adjusted_rate`. **Agent Ops may skip CFO** for small amounts; the amount threshold lives in the approval edge function, not SQL **(inferred)**. CFO may edit amount and fee band before approving.

**Limits.** `get_agent_advance_potential()` scores 0–100: network 55/15, collections 15, repayment 5, listings 5, requests 5. `suggested_amt = power(score/100, 1.3) * 900,000`, ceiling **UGX 9,000,000**, base **UGX 20,000**. New agents get 30% of theoretical max; repeat agents `min(1.0, 0.50 + 0.40*repay_rate + 0.10*min(repaid_count/3,1))`. (Limits were deliberately reduced to ~30% of an earlier scheme.)

**Fees.** `enforce_tiered_advance_rate`: **33% monthly** for a first advance, **28%** once one is completed; hard cap 0.33 (`ADVANCE_RATE_ABOVE_STANDARD`). Compound form (frontend + `apply_advance_topup`): `principal * (1.33^(days/30) - 1)`. Trigger recompute path uses the simple form — **divergence flagged in §21**. Registration fee: **UGX 10,000 if principal ≤ 200,000, else 20,000**.

**Integrity guards.**
- `enforce_advance_principal_integrity` — min 1,000 on insert; principal may never increase (`ADVANCE_PRINCIPAL_INFLATION_BLOCKED`).
- `enforce_agent_advance_min_principal` — blocks approval/payment transitions below 10,000.
- `trg_enforce_no_double_agent_advance` — **one live advance only**: blocks if any `agent_advances` in `active|overdue` with `outstanding_balance > 0`, or any request already in the pipeline. `request_kind='topup'` is re-validated against `agent_advance_topup_eligibility` and forced to the current advance's `parent_advance_id`.
- `verify_advance_disbursement_matches_principal` — sums `agent_advance` wallet cash_ins within ±10 min of issue; raises `ADVANCE_DISBURSEMENT_EXCEEDS_PRINCIPAL`.

**Top-ups.** `agent_advance_topup_eligibility()` requires: live advance with balance; nothing in the pipeline; not behind schedule (no arrears, not overdue); **≥30% repaid** of `principal + access_fee + registration_fee`; `max_topup = floor(principal*0.90) ≥ 10,000`. `apply_advance_topup()` (cfo/manager/agent_ops/coo/super_admin or service role) charges a fresh compound fee on the top-up only, extends `cycle_days`/`expires_at`, recomputes `installment_amount`.

**Repayment schedule.** `advance_period_days`: daily 1, weekly 7, biweekly 14, monthly 30. `advance_installment_amount = ceil(total_payable / installments)` unless overridden. `advance_expected_repaid_to_date` caps at `total_payable`.

**Recovery, two layers.**
1. `sweep_agent_advance_recovery()` — sweeps **withdrawable only**, FIFO by `issued_at`, excludes `recovery_source='roi'`, gates weekly/biweekly/monthly to the due day anchored on the last successful deduction (self-correcting after missed runs), never exceeds `expected_to_date − paid_to_date`, writes `deduction_status ∈ {full, partial, not_due, ahead, prepaid}`, and grows `arrears_balance` by the shortfall.
2. `process-agent-advance-deductions` — daily 18:00 EAT scheduled installments.

**Arrears never compound.** A missed day increases `arrears_balance`, not principal. `trg_cap_advance_arrears` clamps arrears to `[0, outstanding_balance]` and zeroes it on completion. `recover_agent_arrears_from_credit()` applies incoming earnings FIFO to arrears (only for advances issued on a prior calendar day, bounded by `get_user_available_balance`), posting paired `agent_repayment` legs + notification + `system_events`.

**Voluntary prepayment.** `voluntary-repay-advance`, `cfo-record-advance-payment`, `StaffRepayAdvanceDialog.tsx`. Prepayments populate `prepaid_installments_remaining`, consumed one per due period by the sweep (shifting, not shrinking, the schedule).

**Double-charge guard.** `zz_guard_agent_advance_double_charge()` (named to sort last so it runs after other BEFORE triggers) row-locks the advance `FOR UPDATE` and rejects: stale reads (`opening_balance > outstanding + 1` → `ADVANCE_LEDGER_STALE_OPENING`, logs `repayment_skipped_insufficient_balance` / `stale_opening_balance`), over-collection beyond `outstanding + interest_accrued + 1`, and same-day totals beyond `installment + arrears + 1` (`ADVANCE_PERIOD_CAP_EXCEEDED` / `daily_cap_exceeded`).

**Completion.** Set to `completed` inside the sweep or the arrears recovery when `outstanding_balance ≤ 0`. Pre-disbursement negatives terminate as `rejected`; a distinct post-disbursement cancel path was not located.

**Merge / duplicate handling.** `CFOInitiateAdvanceDialog.tsx` supports CFO-initiated advances with duplicate-account detection so advances can be merged onto the active account.

## 13. Business Advances (Tenant/Agent)

`business_advances` (56 cols), enum `business_advance_status` mirroring the 5-stage shape. `calculate_business_advance_limit(tenant)`:

- `rent_history_records` (`pending` + `verified`), `total_months` capped at 12.
- 0 months → flat **UGX 50,000**, tier `Starter`, unlock at 3 months.
- `base = avg_rent * total_months`; **+20%** if ≥6 months, **+15%** if 1–2 distinct landlords, **+25%** if ≥12 months.
- `total = max(50,000, base + bonuses)`, platform ceiling **UGX 10,000,000**.
- Tiers: `Building` (<6), `Established` (6–11), `Welile Trusted` (≥12); previews at `avg_rent*6*1.20` and `avg_rent*12*1.60`.

Supporting functions: `business-advance-stage-reminders` (per-stage SLA, e.g. `coo_approved → disbursed`, ETA 12h), `disburse-business-advance`, `repay-business-advance`, `process-business-advance-compounding` (daily), `claim-business-advance-account`.

---

## 14. Merchant Agent Operations

**Model.** A merchant claims a pending withdrawal, pays the end user from their own MoMo, and is reimbursed **principal + 0.5% commission** into float → withdrawable. The **tiered telecom sending fee is debited from their float**, so Welile's float ledger matches the merchant's actual MoMo statement.

- `auto_dispatch_withdrawals(batch_size=100)` — targets `withdrawal_requests` with `status='cfo_approved' AND assigned_cashout_agent_id IS NULL AND auto_dispatched=false`. VIP-first (`amount ≥ 500,000`), `priority_level`: `vip` ≥500k, `high` ≥100k, else `standard`. Matches on `handles_cash|bank|mtn|airtel` and `current_queue_count < max_daily_payouts`, picks least-loaded, increments the queue counter.
- `accept_withdrawal_dispatch(id)` — caller must be an active `cashout_agents` row; verifies not already claimed and status still open (`pending|requested|manager_approved|cfo_approved|fin_ops_approved`); atomically claims and marks other pending `withdrawal_notification_log` rows `superseded`.
- `ignore_withdrawal_dispatch`, `merchant_set_online`, `release_stale_cashout_claims()` (cron `*/5 * * * *`, **45-minute claim release timeout**).
- Notifications/reports: `notify-merchant-agent-assigned`, `notify-merchants-new-withdrawal`, `merchant-cashout-daily-report`, `generate-daily-merchant-commission`.
- **Fraud rule (hard).** `enforce_no_merchant_agent_auto_debit()` on `general_ledger` blocks any `production`, `wallet`-scope, `cash_out` entry whose description matches `%Auto-debit (phone match)%` or `%Auto-debit (name match)%` when the target is a merchant agent → `MERCHANT_AGENT_AUTO_DEBIT_BLOCKED (Rule 2)`. Gmail-parsed heuristics may never touch merchant float.
- **Referral.** `merchant_agent_referrals` + `pay_merchant_agent_referral_bonus` trigger on `cashout_agents`; daily CMO performance email reports.
- **Commission unification.** All withdrawable merchant commission is projected into the **Agent Wallet Card** as the single source of truth.

## 15. Merchandise & Service Center

| RPC | Behaviour |
|---|---|
| `agent_purchase_merchandise(catalog_id, qty)` | Instant wallet debit against `get_user_available_balance`; paired `wallet_deduction`/`debt_recovery` legs; key `merch_purchase_<sale_id>` |
| `agent_order_merchandise(catalog_id, qty)` | Credit order; `qty ≤ 20`, order value ≤ **UGX 2,000,000**; 5-minute duplicate-order guard (same item/qty/customer) |
| `agent_order_smartphone(amount)` | Agent chooses repayment amount (min 1,000), bounded by available balance; final price set by marketing |
| `agent_order_spiro_bike(amount)` | Same, plus `SPB-XXXXXXXX` tracking reference |

Service Center (`/agent/service-center`, `get_agent_service_center()`): purchases, sub-agent roster, suspension, tenant transfers.

## 16. Sub-Agent Network

- `agent_subagents` (link, `status='verified'`), `subagent_tenant_transfers`, `agent_landlord_assignments`.
- Referral attribution via `referralAttribution.ts` (60-day localStorage persistence). Landlord referral copy no longer advertises "I earn 500 for referring you"; links are shortened via `createShortLink`.
- `sweep-link-campaign-sub-agents` cron (`*/5 * * * *`) reconciles campaign-link signups to parents — this is the mechanism that fixes "agents can't see their invited sub-agents".
- Recruiter override: parent receives 2% of a sub-agent's 10%.

## 17. Security Model

- **Pattern:** RLS is "own row SELECT/INSERT + staff sees all". Mutations on `agent_advances`, `agent_advance_ledger`, `agent_advance_topups` are **manager-policy only** — agents cannot write their own credit rows. `agent_earnings` has "Deny direct earnings inserts"; `agent_vouch_limit_history` has "Block client inserts". All real mutation flows through `SECURITY DEFINER` RPCs with `search_path=public`.
- **Column-level guards:** `restrict_agent_profile_edits` (profiles), `guard_rent_request_agent_columns`, `guard_rent_request_agent_updates`, `guard_landlord_payment_edit_agent_columns`, `enforce_agent_listing_block` (house_listings), `enforce_agent_perf_withdrawal` (withdrawal_requests).
- **Staff gate:** `agent_ops_directory_guard()` raises `auth_required` / `not_authorized` unless caller is `is_ops_role`, manager, cfo, ceo, coo, cto, or super_admin.
- **AML/KYC:** `enforce_kyc_withdrawal_cap()` — accounts <30 days old capped at **UGX 50,000/day**; `kyc_profiles.daily_withdrawal_cap_ugx` per-user override (0/negative = uncapped); frozen KYC raises hint `kyc_frozen`; skipped for `landlord_payout_id`/`proxy_partner_id` rows; "graduated" agents (existing live advance, a completed withdrawal, or any collection row) bypass entirely.
- **Transfer gate:** user→user transfers require ≥10 deposits.
- **Treasury guard:** `checkTreasuryGuard` blocks money movement while the platform is paused (CTO/super_admin bypass).
- **Data minimisation:** Running Balance hidden from agents/users in drawers, statements and PDFs.

## 18. Cron & Scheduled Jobs

> `cron.job` is not readable with the available role (`permission denied for schema cron`); the table below is reconstructed from `cron.schedule(...)` calls in migrations plus `send-system-context/doc.ts`.

| Job | Cadence | Target |
|---|---|---|
| `process-agent-capability-jobs` | every 30s | capability grant/revoke queue |
| `release-stale-cashout-claims-every-5min` | `*/5 * * * *` | `release_stale_cashout_claims()` |
| `sweep-link-campaign-sub-agents` | `*/5 * * * *` | campaign-link → parent reconciliation |
| `detect-withdrawable-drift-alerts-every-15min` | `*/15 * * * *` | withdrawable drift alerts |
| `sweep-agent-advance-recovery` | **conflict:** `*/15 * * * *` then re-registered `0 4 * * *` | `sweep_agent_advance_recovery()` |
| `reconcile-agent-landlord-float` | `17 * * * *` | `reconcile_agent_landlord_float_all(false,false,'scheduled_scan','cron')` |
| `snapshot-agent-daily-eligibility` | `30 0 * * *` | `snapshot_agent_daily_eligibility(1)` |
| `process-agent-advance-deductions` | daily 18:00 EAT | scheduled installments |
| `merchant-cashout-daily-report` | daily | merchant report |
| `auto_dispatch_withdrawals` / redispatch | ~every minute | withdrawal dispatch |
| `expire-stale-bonus-restrictions` | daily | bonus restriction expiry — **currently failing** |
| `recalculate-trust-scores-nightly` | nightly | trust score recompute — **currently failing** |

## 19. Reconciliation & Audit Surfaces

| Surface | Purpose |
|---|---|
| `v_agent_landlord_float_reconciliation` | cached vs recomputed LP float, `difference`, `open_allocations` |
| `agent_landlord_float_corrections` | applied corrections with before/after and reason |
| `v_operational_float_tid_duplicates` | duplicate normalised TIDs across float-delivery rows |
| `operational_float_audit_log` | `created`/`edited` diffs on deposit-request float amounts |
| `agent_tenant_float_reversals` | one-per-group allocation reversals with commission clawback |
| `agent_allocation_traces` | allocation decision tracing **(inferred — schema not read)** |
| `agent_misrouted_deposits_preview` | staging for misrouted deposits **(inferred — schema not read)** |
| `agent_capability_ops_dead_letters` / `_undo_snapshots` | failed capability jobs + rollback state |
| `agent_recommendation_audit`, `tenant_reassignment_audit`, `audit_logs`, `system_events` | human-readable trails |
| `wallet_overdraw_events` | post-hoc negative-bucket anomalies |

## 20. End-to-End Workflows

**A. Landlord acquisition → funded rent → collection → earnings**
1. Agent registers landlord; on verification the agent earns UGX 5,000 (LC verified 2,000).
2. Agent lists house (2,000 on approval), registers tenant, posts a rent request.
3. `enforce_agent_daily_eligibility` + `agent_per_tenant_max` gate the request size.
4. Ops/COO approve → CFO calls `fund-agent-landlord-float` → allocation row created, LP float derived up, ledger pair posted, UGX 5,000 bonus paid.
5. Agent pays the landlord (OTP to landlord phone, GPS captured) → `agent_float_withdrawals` → merchant dispatch settles.
6. Tenant repays daily; `agent-deposit` debits agent float, credits tenant, pays 10% commission.
7. `guard_rent_request_agent_updates` requires a same-transaction float debit before `amount_repaid` advances.
8. `auto_close_fully_repaid_rents` closes the request when fully repaid.

**B. Advance lifecycle**
Request (single-slot guard) → Agent Ops → Tenant Ops → Landlord Ops → COO (or Agent Ops skip-CFO) → CFO disburse (disbursement-vs-principal check) → active → 15-min withdrawable sweep + daily 18:00 installments → shortfalls become arrears → earnings intercepted FIFO → optional top-up (≥30% repaid) → `completed`.

**C. Merchant cash-out**
User requests withdrawal → CFO approves → `auto_dispatch_withdrawals` assigns least-loaded matching merchant → merchant claims (`accept_withdrawal_dispatch`, others superseded) → pays from own MoMo → reimbursed principal + 0.5%, telecom fee debited from float → unclaimed after 45 min → `release_stale_cashout_claims` returns it to the pool.

## 21. Known Failure Modes & Open Risks

| Issue | Detection | Status |
|---|---|---|
| Stale opening balance → double charge | `zz_guard_agent_advance_double_charge` (`ADVANCE_LEDGER_STALE_OPENING`) | Guarded; races logged to `system_essevents`/`system_events` |
| Same-day over-collection | Same guard (`ADVANCE_PERIOD_CAP_EXCEEDED`) | Guarded |
| Over-disbursement vs principal | `verify_advance_disbursement_matches_principal` | Guarded |
| LP float double/quadruple funding | 409 `already_funded` + unique live-allocation index | Fixed 2026-07-30 |
| Stuck merchant claims | 45-min release cron | Mitigated |
| Withdrawable/float drift | 15-min drift alert cron + reconciliation views | Alert-only |
| Legacy commission imbalance (~UGX 22M over 8,558 rows) | ledger volume query | **Open — historical data only** |
| Failing crons: `sweep-agent-advance-recovery`, `expire-stale-bonus-restrictions`, `recalculate-trust-scores-nightly` | cron run history | **Open** |
| `sweep-agent-advance-recovery` cadence conflict (15-min vs daily) | migration diff; `cron.job` unreadable | **Open — needs privileged read** |
| Access-fee formula divergence: trigger uses simple interest, top-up/frontend use compound | function-body comparison | **Open — quoted vs applied fee may differ** |
| "Today's Capacity" coupled to `agent_collections`; a missing row makes an active agent look idle | eligibility view | **Open — design coupling** |
| Merchant Gmail auto-debit against float | `MERCHANT_AGENT_AUTO_DEBIT_BLOCKED` | Guarded (hard block) |

## 22. Appendix — Reference Inventory

- **Scale:** ~74 agent-scoped tables/views, ~230 agent-scoped RPCs, 34 ledger triggers platform-wide.
- **Key tables:** `agent_advance_requests`, `agent_advances`, `agent_advance_ledger`, `agent_advance_topups`, `advance_fee_config`, `business_advances`, `agent_landlord_float`, `agent_landlord_float_allocations`, `agent_landlord_float_corrections`, `agent_float_funding`, `agent_float_limits`, `agent_float_withdrawals`, `float_requests`, `agent_collections`, `field_collections`, `offline_collection_submissions`, `agent_earnings`, `agent_visits`, `venue_visits`, `agent_subagents`, `subagent_tenant_transfers`, `agent_landlord_assignments`, `agent_capabilities`, `agent_tier`, `agent_tier_capabilities`, `agent_capability_ops_*`, `cashout_agents`, `merchant_agent_referrals`, `wallet_balances_projection`, `wallets`, `general_ledger`.
- **Key guard triggers:** `enforce_no_negative_wallet_ledger`, `enforce_no_double_agent_advance`, `enforce_advance_principal_integrity`, `enforce_tiered_advance_rate`, `enforce_agent_advance_min_principal`, `verify_advance_disbursement_matches_principal`, `zz_guard_agent_advance_double_charge`, `tg_cap_advance_arrears`, `guard_rent_request_agent_updates`, `enforce_agent_full_freeze`, `enforce_agent_daily_eligibility`, `enforce_agent_rent_request_capacity`, `enforce_kyc_withdrawal_cap`, `enforce_no_merchant_agent_auto_debit`, `trg_sync_landlord_float_from_allocation`, `trg_alfa_status`, `register_float_delivery_tid`.
- **Key edge functions:** `assign-agent-float`, `record-bank-float-transfer`, `transfer-to-float`, `admin-withdrawable-to-float`, `admin-float-to-withdrawable`, `fund-agent-landlord-float`, `agent-deposit`, `agent-withdrawal`, `approve-withdrawal`, `process-agent-advance-deductions`, `voluntary-repay-advance`, `cfo-record-advance-payment`, `notify-agent-advance-disbursed`, `process-agent-capability-jobs`, `notify-merchants-new-withdrawal`, `notify-merchant-agent-assigned`, `merchant-cashout-daily-report`, `generate-daily-merchant-commission`, `business-advance-stage-reminders`, `disburse-business-advance`, `repay-business-advance`, `process-business-advance-compounding`.
- **Follow-up reads to close remaining gaps:** `agent_allocation_traces`, `agent_misrouted_deposits_preview`, `agent_allocate_tenant_payment_internal`, `credit_agent_rent_commission`, `get_agent_split_balances`, `record_rent_request_repayment`, `sync_wallet_from_ledger`, `agent_advance_requests_privileged`, `approve-withdrawal/index.ts`, and a privileged `select * from cron.job`.

---

*This document is descriptive of observed system state. Where marked **(inferred)**, verify before relying on it for financial or legal conclusions.*
