---
name: SOFP leg resolver (balance sheet mapping rules)
description: sofp_ledger_legs is the single resolver behind get_statement_of_financial_position; workflow-aware rules R1-R7 + equity account E4 make the balance sheet balance to zero without any suspense plug
type: feature
---
Fixed 2026-08-24. Full trace: `docs/investigations/Balance_Sheet_Imbalance_Resolved_2026-08-24.md`.

`ledger_account_map` (keyed on scope/category/wallet_bucket) is NOT sufficient on its own: several
categories carry two opposite economics depending on the originating workflow. `sofp_ledger_legs(as_at)`
applies the map and then group-shape-aware overrides:

- **R1** `platform.system_balance_correction` → `A1` when the group touches agent float, else `E3`
  (matches sibling `platform.balance_correction`; the old map had the inverted `debit_when` → A9 suspense).
- **R2** `platform.rent_disbursement` from `agent_advance_requests` → debit `A4` advance receivable.
- **R3** `platform.wallet_deduction` in a float group with no custody leg → `A1` (float swept to platform).
- **R4** `platform.wallet_withdrawal` with wallet legs but no `L1` leg → that leg IS the custody settlement (debit `L1`).
- **R5** float ⇄ withdrawable reclass (`A2` + `L1` wallet pair) → user-side leg expensed to `X4` (CFO-approved: released float is a cost).
- **R6/R7** float legs in groups containing tenant/rent repayment or platform revenue → debit `A2` (cash received).
- **E4** `Legacy One-Sided Postings — Opening Balance Counterpart` in equity carries the counterpart of
  genuinely one-sided historic groups, itemised in the reconciliation schedule.

Rules:
- NEVER add a suspense plug, offset or hard-coded value to make the balance check pass, and never hide a failed check.
- Fix mapping in `sofp_ledger_legs` / `ledger_account_map`, never by editing `general_ledger`.
- After changing the resolver, verify: total debits = total credits, Assets = Liabilities + Equity (diff 0),
  and that R1/X1/X2/X3 (income statement lines) only move where intended.
- Known open item: `A4` sits at a credit balance (~1.22bn) because most advance receivables were never
  posted to the ledger; they live in operational sub-ledgers shown as memo lines. Needs CFO-approved receivable legs.
