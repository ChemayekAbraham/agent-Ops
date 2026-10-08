# 207 — CFO can cancel a disbursed Spiro bike lease and claw the money back (no debt)

**Migration `20261008150000_cfo_cancel_bike_lease.sql`. BUILT and rollback-tested against production 2026-10-08; NOT YET APPLIED, and the Abraham Chelimo lease below has NOT been cancelled.** Verify the live objects after the push.

## Why
CFO Direct Debit ("Take money from wallet") refused 145,000 on Abraham Chelimo (0706982850) with
"Available (strict) UGX 1,000" while his wallet held 145,000, and only offered Forced Reversal,
which would have booked a fake 144,000 recoverable debt.

- The 145,000 was the **old agent-wallet bike-lease disbursement** (sale `27842d46-9467-4852-853e-c4100fbbc516`,
  lease `17b3597a-d2b7-4f5e-89f3-780a9b938585`), credited as `agent_advance_credit`.
- `get_user_available_balance` subtracts `get_advance_locked_withdrawable` (credits of that category minus
  outflows) while `treasury_controls.advance_withdrawals_paused` is on. 145,000 - 1,000 repaid = 144,000 locked.
- The only gate exemption (`advance_reversal:<advance_id>`) needs a real `agent_advances` row. A bike
  lease lives in `merchandise_sales` (+ `agent_bike_leases` mirror, `merchandise_recovery_plans`), so there
  was no advance to tag, and **no RPC existed to cancel a lease after disbursement** (`reject_bike_lease` stops at `coo_approved`).
- The 1,000 "repayment" on 10-07 was the agent's own gift transfer, auto-recovered into the plan.

## Change
1. `enforce_no_negative_wallet_ledger()` — the live body, plus one OR clause in the existing reversal-scoped
   balance branch: a wallet `cash_out` of category `agent_advance_credit`, `source_table = 'merchandise_sales'`,
   `reference_id = 'bike-lease-cancel-' || source_id`, for an `agent_bike_leases` row with that `sale_id`,
   that `agent_id` and `status = 'approved'`. It is checked by shape because `create_ledger_transaction`
   does **not** persist `sub_category` (only `attach_cfo_correction_subcategory` fills it, and only for
   `cfo_direct_credit` legs). A `bike_lease_reversal:` tag, as first proposed, would never have reached the trigger.
2. `cfo_cancel_bike_lease(p_sale_id uuid, p_reason text) returns jsonb` — SECURITY DEFINER, authenticated only,
   CFO approver + `can_cfo_disburse_bike_leases`, reason >= 10 chars. One `create_ledger_transaction` group
   (idempotency key and `reference_id` = `bike-lease-cancel-<sale_id>`), existing categories only, so **no
   `ledger_account_map` or allowlist change**:

   | Leg | Mapped |
   |---|---|
   | wallet cash_in `agent_repayment` (refund) | CR L1 |
   | platform cash_out `bike_recovery_repayment` | DR A13 |
   | wallet cash_out `agent_advance_credit` (clawback) | DR L1 |
   | platform cash_in `equipment_expense` | CR X1 |

   DR = CR = repaid + disbursed. Then plan -> `cancelled` (outstanding 0, on hold), sale -> `rejected`
   (`amount_paid`/`amount_outstanding` 0, `lease_activated_at` null; the sync trigger mirrors it to `agent_bike_leases`),
   `audit_logs` row `bike_lease_cfo_cancelled`. The plan is updated **before** the sale and set to `cancelled`
   so `trg_bike_plan_complete_at_zero` cannot flip it to `completed` and send the agent a "lease fully settled" notification.

Refuses (raises, moves nothing) when: sale not `approved`/disbursed; already cancelled; no agent-wallet
disbursement leg (supplier-paid leases need a supplier refund, not a wallet debit); no active plan;
ledger repayments differ from `plan.amount_recovered`; or the agent already spent part of the disbursement
(wallet after refund < disbursed). **It never creates a `cfo_debit_obligations` row or any receivable.**

## Verification (done)
Ran the migration plus `cfo_cancel_bike_lease('27842d46-…')` as CFO Sarah Angwen inside a DO block that
ends in `RAISE EXCEPTION` (full rollback), then re-read production: wallet 145,000, sale `approved`, plan
`active`, no new function, no ledger rows. Inside the block: wallet 145,000 -> 1,000, locked 0, sale and
lease `rejected`, plan `cancelled`, exactly 4 legs. **Not exercised:** the deferred mapped-balance and
raw-balance constraint triggers (they fire at commit, which the rollback skips); the group was checked by hand.

## Execute (not done — needs Josh's go-ahead)
After the migration is applied: `select cfo_cancel_bike_lease('27842d46-9467-4852-853e-c4100fbbc516', '<reason>')`
as a CFO session. Expected: refund 1,000, clawback 145,000, wallet ends at 1,000 (his own gift money).
After running, check `get_user_available_balance` for the agent and that `ledger_mapped_balance_violations`
has no row for the returned group id.

## Watch
- `enforce_no_negative_wallet_ledger` is not in `critical_function_baselines`, so no re-baseline is needed.
- Other `agent_advance_credit` bike-lease wallets are locked the same way; this tool is per-lease.
- There is no UI button yet (Gemini's lane). Until then it is an RPC call.
- Reuse is blocked by the idempotency reference: a cancelled lease cannot be cancelled twice.
