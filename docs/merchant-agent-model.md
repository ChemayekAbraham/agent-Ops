# Merchant (Cash-Out) Agent Model — System Flow

_Generated 2026-08-17 from the live code and database. Every statement below is
traceable to a named file, RPC, table, view or ledger category._

Companion docs: `docs/merchant-agent-payout-process.md` (payout gates, older
narrative), `mem/features/financial-ops/merchant-float-position-math.md`,
`mem/business-model/merchant-telecom-float-charge.md`.

---

## 1. What a merchant agent is

A **merchant agent** (a.k.a. cash-out agent, "desk") is an agent with an
**active row in `public.cashout_agents`** (`src/hooks/useIsMerchantAgent.ts`,
DB helper `is_merchant_agent(p_user_id)`).

Policy: a merchant agent is *solely a payout operator*. Tenant operations,
landlord operations and house listing are hidden/blocked for them
(`MERCHANT_RESTRICTION_MESSAGE` in `src/hooks/useIsMerchantAgent.ts`).

Key `cashout_agents` columns that drive behaviour:

| Column | Effect |
|---|---|
| `is_active` | Membership gate. Inactive ⇒ not a merchant. |
| `handles_cash`, `handles_bank`, `handles_mtn`, `handles_airtel`, `config` | Payout-method permission matrix (`merchant_handles_payout`, `merchant_config_allows_payout`, `merchant_agent_allows_withdrawal`). |
| `is_online`, `online_changed_at` | Dispatch availability (`merchant_set_online`). |
| `float_phone`, `personal_phone`, `payout_numbers_set_at` | Mandatory payout-number gate (`merchant_set_payout_numbers`, UI `MerchantPayoutNumbersGate.tsx`). |
| `max_daily_payouts`, `current_queue_count`, `priority_threshold` | Queue/dispatch limits. |
| `label` | Desk name used in every report. |

---

## 2. Tables & views connected to a merchant agent

**Identity / permissions**
- `cashout_agents` — the desk itself (1 row per desk, `agent_id → profiles.id`).
- `merchant_agreement_acceptance` — signed merchant agreement (`signature_data_url`, version, IP/device).
- `merchant_agent_referrals` — merchant recruitment/referral bonuses (`pay_merchant_agent_referral_bonus`, `auto_activate_merchant_referral`).

**Money held / balance**
- `wallets` (`float_balance`) — the company float the merchant holds. Cache, written only by `apply_wallet_movement`.
- `general_ledger` — the truth. Merchant-relevant categories: `agent_float_deposit` (float in), `agent_float_settlement` (float out: principal + telecom), `agent_commission_earned` (0.5% commission in), `wallet_withdrawal` (customer's liability discharged).
- `v_user_wallet_strict` — the pivot between cache and ledger; every merchant position reads through it.
- `merchant_float_deliveries` — one row per real company→merchant phone transfer, keyed by normalized TID + optional `gmail_transaction_id` (`record_merchant_float_delivery`).
- `merchant_float_requisitions` — FinOps/ops request for a float top-up, CFO decides (`MerchantFloatRequisitionPanel.tsx`, `MerchantFloatRequestsPanel.tsx`).
- `merchant_float_reconciliations` — display-only narrative corrections (`opening_balance`, `reimbursement_recorded`, `payout_correction`, `write_off`), reason ≥ 10 chars, CFO/FinOps/manager only. **Moves no money.**
- `merchant_float_variance_alerts` + `v_merchant_float_ledger_variance` — cache vs ledger drift (`detect_merchant_float_variances`).
- `merchant_balance_disputes` — merchant raises "my balance is wrong" (`MerchantBalanceDisputeDialog.tsx`, FinOps `MerchantBalanceDisputesPanel.tsx`).

**Payout execution**
- `withdrawal_requests` — the customer payout request; carries `assigned_cashout_agent_id`, `dispatch_claimed_by`, `processed_at`, `fin_ops_reference`, `payout_proof_path`, `settlement_state`.
- `v_merchant_payout_queue` + `src/lib/merchantPayoutQueue.ts` — the one predicate for "still needs paying": queue status AND `processed_at IS NULL` AND `fin_ops_reference IS NULL`.
- `merchant_float_reservations` — per-withdrawal float reservation (`state`, `float_before`, `reserved_amount`, `planned_out_of_pocket`, `consumed_float`, `consumed_telecom`, `float_after`, `receivable_after`).
- `merchant_payout_funding` (+ `v_merchant_payout_funding_mismatch`) — post-hoc classification of each payout into float vs merchant own cash (`classify_merchant_payout_funding`, `reconcile_merchant_payout_funding`).
- `merchant_out_of_pocket_advances` — receivable filed when float could not cover the payout (`kind` = principal/telecom, `status` = `needs_review` → `pending_reimbursement`).
- `merchant_commission_awards` — one row per payout commission (UNIQUE per `withdrawal_id`), the idempotency guard for the 0.5%.
- `settlement_reconciliation_ledger` — where a *failed* float or receivable leg is logged instead of being lost.
- `audit_logs`, `system_events` — every settlement, opt-out attempt and shortfall.

**Reporting**
- `v_merchant_float_position`, `get_merchant_float_position(agent)`, `get_merchant_float_positions()`, `get_merchant_payout_float()`, `v_merchant_payout_float_trace`, `merchant_payout_success_matrix/_summary`, `merchant_payout_success_runs`, `generate_merchant_cashout_daily_report(date)`, `generate_daily_merchant_commission_report(date)`, `v_merchant_commission_outstanding`.

---

## 3. Balance definitions (what each number means)

`get_merchant_float_position(p_agent_id)` returns:

```
float_balance              = GREATEST(wallets.float_balance, 0)
reserved_float             = merchant_reserved_float(agent)   -- open reservations
available_float            = GREATEST(float_balance - reserved_float, 0)
out_of_pocket_outstanding  = Σ shortfall WHERE status='pending_reimbursement'
out_of_pocket_under_review = Σ shortfall WHERE status='needs_review'
out_of_pocket_headroom     = treasury_controls['merchant_out_of_pocket_headroom']
```

`v_merchant_float_position` adds the desk view:

```
net_position = float_signed - reserved - own_cash_pending - own_cash_under_review
state        = 'OWED' when net_position < 0 else 'FUNDED'
```

`get_merchant_payout_float()` (the pool headline shown on the merchant home card):

```
withdrawable_total     = Σ GREATEST(wallets.withdrawable_balance,0)
landlord_float_total   = Σ GREATEST(agent_landlord_float.balance,0)
claimed_unsettled_total= Σ withdrawal_requests.amount for non-terminal claimed payouts
available_float        = GREATEST(withdrawable_total + landlord_float_total - claimed_unsettled_total, 0)
+ own_float_balance / own_reserved_float / own_available_float / own_out_of_pocket_outstanding
```

`get_merchant_float_positions()` (FinOps "Money With Agents") — reimbursement is
**ledger-only**: `float_credits_recorded` = `general_ledger` legs with
`wallet_bucket='float'`, `direction='cash_in'`, `category='agent_float_deposit'`,
classification ≠ `admin_correction`. Matched Gmail transactions are **evidence
only** and are never added (adding both double-counted).

---

## 4. Money movement — the five events

### 4.1 Company credits the merchant with float

Every legitimate float-in path posts the same balanced pair:

| Leg | Scope | Direction | Bucket | Category |
|---|---|---|---|---|
| Float into the merchant's wallet | wallet | cash_in | **float** | `agent_float_deposit` |
| Company cash out | platform | cash_out | — | `agent_float_deposit` |

`recipient_type` is `operational_wallet`, which is the sole signal that routes
the credit to the **float** bucket (never withdrawable).

Entry points that produce those legs:
- `approve-deposit` edge function (agent deposit approved as operational float).
- `cfo-direct-credit` with category `agent_float_deposit` (CFO Direct Credit tool, `DirectCreditTool.tsx`).
- `finops_manual_float_credit` RPC (`ManualFloatCreditPanel.tsx`) — TID + depositor name + timestamp required.
- `gmail-poll-transactions` auto-credit of a matched outgoing company transfer, which also writes `merchant_float_deliveries` via `record_merchant_float_delivery(tid, agent, amount, provider, gmail_tx, occurred_at)` (TID-normalized, idempotent).
- `post_merchant_opening_float_ledger(desk, agent, amount, reason, evidence_note)` — recognises float the agent already physically holds; the only correction path that changes "they're holding our money", because it posts real legs and moves the bucket through `apply_wallet_movement`.
- `transfer-to-float` / `ops-bucket-transfer` for bucket moves.

Effects: `wallets.float_balance` rises (via ledger trigger → `apply_wallet_movement`),
`available_float` rises, `v_merchant_float_position.state` moves toward `FUNDED`,
and the FinOps board's `float_credits_recorded` increases.

### 4.2 "The company sends the merchant agent money" (cash on the phone, not yet booked)

Sending MTN/Airtel money to the merchant's `float_phone` does **not** by itself
change any balance. Until a ledger `agent_float_deposit` pair exists, the transfer
is only *evidence*:

1. `gmail_transactions` captures the outgoing telecom email.
2. `email_matched_total` in `get_merchant_float_positions()` shows it as evidence.
3. Booking happens only when auto-credit matches it (→ 4.1) or FinOps records it
   manually (`finops_manual_float_credit` / `post_merchant_opening_float_ledger`).

If it is never booked, the desk shows as under-funded and `v_merchant_float_ledger_variance`
/ `merchant_float_variance_alerts` flag the gap. Narrative-only entries in
`merchant_float_reconciliations` explain such gaps but do **not** create spendable float.

### 4.3 The merchant pays a customer (withdrawal settlement)

Handled entirely by `supabase/functions/approve-withdrawal/index.ts`.

**Step order**

1. **Claim** — status flipped atomically so two desks can't pay the same request; the queue fence (`src/lib/merchantPayoutQueue.ts`) evicts the row.
2. **Merchant identity resolved server-side** by `resolve_payout_merchant_identity(actor)`. Client flags (`acting_as_merchant`, `staff_desk`) cannot suppress merchant treatment; an opt-out needs `merchant_opt_out: true` **and** a ≥10-char reason, and a silent attempt is logged as `merchant_opt_out_rejected`.
3. **Gates** — fraud block, WPO pickup code, chosen-merchant gate, brute-force limiter, duplicate reference, payout-method permission matrix, payout-numbers gate, **proof-of-payment gate** (no proof ⇒ no wallet debit), balance/pivot guard.
4. **Float reservation** — `reserve_merchant_float(withdrawal_id, agent)` writes `merchant_float_reservations` and returns the amount usable for *this* payout (held float minus float already committed to the desk's other open claims). Two concurrent claims can never spend the same shillings. Fallback: `get_merchant_float_position().available_float`.
5. **Split computed**
   ```
   telecom_expected      = getTelecomSendingCharge(amount)   -- 100/500/1,000/1,500/2,000 tiers
   float_for_principal   = min(reserved, amount)
   principal_shortfall   = amount - float_for_principal
   float_for_telecom     = min(reserved - float_for_principal, telecom_expected)
   telecom_shortfall     = telecom_expected - float_for_telecom
   ```
6. **Customer liability discharged** — wallet `cash_out` / `wallet_withdrawal` (or `agent_commission_withdrawal`) on the beneficiary, bucket `withdrawable`.
7. **Float consumed (principal)** — idempotency key `approve-withdrawal-merchant-float-consume-<id>`, reference `<id>-merchant-float-consume`:

   | Leg | Scope | Direction | Bucket | Category |
   |---|---|---|---|---|
   | Merchant float out | wallet | cash_out | **float** | `agent_float_settlement` |
   | Float settled to platform | platform | cash_in | — | `agent_float_settlement` |

8. **Telecom sending charge** — same pair, reference `<id>-merchant-telecom-charge`, key `...-merchant-telecom-charge-<id>`. Invariant: **Float allocated = customer payouts + telecom charges + remaining float.**
9. **Shortfall filed** — any principal/telecom shortfall is upserted into `merchant_out_of_pocket_advances` (`onConflict: withdrawal_id,kind`) with `status='needs_review'` and a `system_events` record. It is *not* debt yet (see 4.4).
10. **Reservation closed** — `consume_merchant_float(withdrawal_id, agent, consumed_float, consumed_telecom, out_of_pocket)` stamps float before → reserved → consumed → fronted → float after → receivable after.
11. **Commission** — `credit_merchant_payout_commission(withdrawal_id, 'settlement_event')`:
    - eligibility from `merchant_commission_eligibility` (server-resolved merchant + a real customer wallet debit + terminal-good status);
    - `merchant_commission_awards` UNIQUE insert is the idempotency guard;
    - legs: platform `cash_out` `agent_commission_earned` ↔ wallet `cash_in` `agent_commission_earned`, `recipient_type:'user'`, bucket **withdrawable**, rate **0.5%**, reference `<id>-cashout-commission`.
    - Commission is NOT gated on the float leg succeeding; a 15-minute reconciler (`reconcile_merchant_payout_commissions`) pays anything missed.
12. **Funding classification** — `classify_merchant_payout_funding(withdrawal_id)` writes `merchant_payout_funding` (float vs own cash per payout); `reconcile_merchant_payout_funding` sweeps the last 72h.
13. **Notifications & receipt** — SMS/push to customer and merchant plus the public proof-of-payment receipt link; status becomes `completed`/`paid`.
14. **Failure handling** — a failed float or receivable leg is written to `settlement_reconciliation_ledger`; a settlement closing with **no** float debit and **no** receivable logs `MERCHANT_CHAIN_SKIPPED`. Failed gates release the claim (and `release_merchant_float` / `release_stale_merchant_float_reservations` free the reservation).

**Net effect of one payout of A:** company float held by the merchant → customer;
merchant float drops by `A + telecom(A)`; merchant withdrawable rises by
`round(0.005 × A)`. **Nothing of the principal ever lands in the merchant's
withdrawable.**

### 4.4 The merchant hits zero float

Zero float does **not** block a payout any more. The code path is explicit:

- `reserve_merchant_float` reserves whatever exists (possibly 0) and records `planned_out_of_pocket`.
- The payout proceeds; only the float that exists is debited (`float_for_principal` may be 0, in which case no float leg is posted at all).
- The uncovered part is filed in `merchant_out_of_pocket_advances` with `status='needs_review'`, per `kind` (`principal`, `telecom`).
- **Evidence gate:** a shortfall alone is not proof the merchant spent their own money. Debt only exists once the merchant attests or FinOps confirms via `review_merchant_out_of_pocket(id, decision, note)`, moving the row to `pending_reimbursement` (or rejecting it). See `mem/constraints/merchant-own-money-evidence-gate.md`.
- While outstanding, `out_of_pocket_outstanding` rises, `v_merchant_float_position.net_position` goes negative and `state` becomes **`OWED`**.
- `treasury_controls['merchant_out_of_pocket_headroom']` bounds how much fronting is tolerated.
- Recovery: the desk is refunded by a normal float credit (4.1) — a real `agent_float_deposit` — usually after a `merchant_float_requisitions` request is approved by the CFO.
- Merchant-facing surface: `MerchantFloatAvailableCard.tsx` shows `spendable = holding − reserved`, owed amount, rows awaiting confirmation, and a dispute button.

### 4.5 The merchant withdraws their own earnings

Separate, ordinary withdrawal: the merchant's **withdrawable** bucket (commission
+ payroll etc.) gated by `get_user_available_balance` / the strict wallet view.
Float is excluded by construction (`src/lib/withdrawAvailability.ts`) and can
never be withdrawn.

---

## 5. Guardrails

- `apply_wallet_movement` is the only wallet-bucket writer; direct bucket updates are blocked by `enforce_wallet_ledger_only`.
- `recipient_type` decides the bucket: `user` → withdrawable, `operational_wallet` → float (trigger `trg_set_wallet_bucket_from_recipient_type`).
- `enforce_merchant_payout_authorization` and `enforce_no_merchant_agent_auto_debit` are DB-level payout guards.
- `trg_enforce_settled_withdrawal_terminal` refuses to move a settled payout back into a queue state.
- Every merchant money leg is idempotent by `idempotency_key` / `reference_id`, so retries cannot double-spend float or double-pay commission.
- `merchant_float_reconciliations` is narrative only; the general ledger is the source of truth (Phase 10).

---

## 6. Scheduled jobs & reports

| Job / RPC | When | Output |
|---|---|---|
| `merchant-cashout-daily-report` | 21:00 UTC = 00:00 EAT | Per-desk payouts, commission, telecom, float consumed, settlement-status pills; emailed to the fixed ops recipients. |
| `generate_daily_merchant_commission_report(date)` | daily | Commission accrual vs paid. |
| `detect_merchant_float_variances` | scheduled | `merchant_float_variance_alerts` on cache↔ledger drift. |
| `release_stale_merchant_float_reservations` | scheduled | Frees reservations for abandoned claims. |
| `reconcile_merchant_payout_commissions` (≈15 min) | scheduled | Pays commissions missed at settlement time. |
| `reconcile_merchant_payout_funding(72h)` | scheduled | Backfills `merchant_payout_funding` classification. |
| `record_merchant_payout_success_run(days)` | scheduled | `merchant_payout_success_runs` reliability matrix. |

---

## 7. Quick reference — categories

| Category | Direction/bucket | Meaning |
|---|---|---|
| `agent_float_deposit` | wallet cash_in / float | Company credits the merchant with float |
| `agent_float_settlement` | wallet cash_out / float | Float consumed: payout principal **and** telecom charge |
| `agent_commission_earned` | wallet cash_in / withdrawable | 0.5% payout commission |
| `wallet_withdrawal` | wallet cash_out / withdrawable | Customer's balance discharged by the payout |
| `agent_float_assignment` / `agent_float_funding` | wallet/platform | Pool-funded proxy settlements (not merchant own float) |
