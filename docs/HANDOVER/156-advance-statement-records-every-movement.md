# 156 — Every advance movement is recorded on the statement

**Status: LIVE 2026-09-29.** Migration `20260929160000_advance_statement_records_every_movement.sql`, applied via `query_database` and verified.

## Why

Josh: *"whenever any deduction takes place it should be recorded very well."* Handover notes 150, 154 and 155 kept finding the same three faults:
- the balance moves with no statement row
- a +0/−0 row changes the balance
- a CFO external payment is labelled as a wallet deduction (`wallet_daily`) with no reference, which is how the fake clearances looked real

Fourteen functions change `agent_advances.outstanding_balance`. Seven never write a statement row: `apply_advance_topup`, `cancel_agent_advance`, `pause_agent_advance`, `resume_agent_advance`, `reconcile_advance_statuses`, `reverse_agent_advance`, `update_agent_advance_terms`. Daily recovery (`record_advance_deduction_atomic` and friends) was already atomic.

## What changed

| Piece | What it does |
|---|---|
| New columns on `agent_advance_ledger` | `adjustment_amount` (signed; closing = opening + interest_accrued − amount_deducted + adjustment_amount), `wallet_entry_id`, `ledger_group_id`, `note` |
| `zz_advance_balance_must_be_on_statement` (DEFERRED constraint trigger on `agent_advances`) | At commit, if `outstanding_balance` doesn't equal the statement's last closing, it writes a `balance_adjustment` row with the signed amount and the cause, plus an exception. The cause is the `welile.advance_adjustment_note` GUC if set, else the `audit_logs` entry of the same transaction, else "no audit reason". |
| `zz_advance_deduction_link_payment` (DEFERRED constraint trigger on `agent_advance_ledger`) | At commit, it links every deduction row to the wallet debit that paid it: same agent, same amount, ±5 s, one to one. For a CFO external payment it links the platform receipt instead. Neither found means an exception. |
| `advance_statement_exceptions` | Exceptions for the CFO to review. RLS: CFO/CEO/COO/Manager read. |
| `cfo_record_advance_payment` | Statement rows now carry `recovery_source` = `external_<method>` or `wallet_offset`, `ledger_group_id` and `note` ("CFO recorded payment, ref …"). |
| `get_advance_wallet_reconciliation` | Understands `adjustment_amount` and external payments, and returns `adjustment`, `note` and `paid_outside_wallet` per row. |

Nothing here moves money or blocks a deduction. Deferred triggers judge the final state of the transaction, so writer order doesn't matter.

## Verified (29 Sep, each test inside a rolled-back transaction)

1. Ian's advance balance +5,000 with no row → `balance_adjustment` row: opening 4,793,672.08, adjustment +5,000, closing 4,798,672.08, note = the GUC text; 1 exception.
2. A 777 deduction row with no wallet debit → a `deduction_without_wallet_debit` exception.
3. A deduction row matching Ian's latest real wallet debit (280) → `wallet_entry_id` linked to that debit; 0 exceptions.

After the tests: 0 exceptions kept, Ian 4,793,672.08 unchanged, Ian and Fred still reconciled.

## For writers from now on
- Changing a balance on purpose? `set_config('welile.advance_adjustment_note', '<why>', true)` in the same transaction, or write the audit log in the same transaction. Otherwise the row says "no audit reason".
- Rows that aren't cash must still use `amount_deducted = 0`. The double-charge guard and the deduction notification fire on INSERT with `amount_deducted > 0`.
- Historical rows are **not** backfilled with `wallet_entry_id`. The Wallet check (handover 154) still matches history live.

## Watch
The first days of `advance_statement_exceptions`. A writer that updates the balance and inserts its row in **separate** transactions would produce an adjustment row followed by a duplicate movement. None was found in the code (the edge function only writes 0-deduction marker rows), but this is the failure mode to look for.
