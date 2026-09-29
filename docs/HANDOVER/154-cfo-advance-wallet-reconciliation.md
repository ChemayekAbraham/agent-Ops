# 154 — CFO Advances: "Wallet check" reconciles each advance against the wallet

**Status: RPCs live in production 2026-09-29 (applied via `query_database`). The UI goes live once Lovable publishes.**

## Why

Doc 150 cleaned Ian Muhwezi's 7 Sep advance statement by hand so that every deduction row matched a wallet debit. Josh asked for the CFO dashboard to show this for any advance: when it was paid out, the total to repay, day-by-day deductions from the wallet next to the statement, and every row where the two disagree.

## What was built

| Piece | Where |
|---|---|
| `get_advance_wallet_reconciliation(p_advance_id)` returns jsonb `{advance, totals, days, issues, rows}`. Read-only, SECURITY DEFINER, CFO/CEO/COO/Manager only (callers with no `auth.uid()`, such as SQL and cron, are allowed) | `supabase/migrations/20260929150000_cfo_advance_wallet_reconciliation.sql` |
| `get_advance_reconciliation_summary(p_advance_ids uuid[])` returns badge data for up to 100 advances per call. About 0.6 s for 25 | same |
| `useAdvanceWalletReconciliation` / `useAdvanceReconciliationSummary` + `ADVANCE_RECON_ISSUE_LABEL` | `src/hooks/useAdvanceWalletReconciliation.ts` |
| `AdvanceWalletReconciliationDialog`, a plain layout left for Gemini to style | `src/components/cfo/AdvanceWalletReconciliationDialog.tsx` |
| A **Wallet ✓ / Wallet: N issues** button on every row of the CFO Advances table (all statuses) | `src/components/cfo/CFOAdvancesManager.tsx` |

### Matching rules
- **Statement row matched to a wallet debit.** A statement row with `amount_deducted > 0` needs an unused wallet `cash_out` (`agent_repayment` / `agent_advance_repayment`) for the same agent, with the same amount and within ±3 s.
  - Matching is **greedy and one-to-one**, so bursts of identical deductions pair up correctly. For example, Okwakol had twenty 10,000 debits at 06:39:03 on 28 Jul.
  - Matching goes by agent, not by `source_id`, so deductions moved between advances (doc 150) still match.
- **Row order.** Rows are ordered by `created_at, opening_balance DESC, id`. Rows written in the same instant would otherwise show fake balance jumps that net to 0. That produced 31 false jumps on Okwakol's May advance before this fix.
- **Issue kinds:**
  - `balance_jump`: the opening balance doesn't equal the previous row's closing balance.
  - `deduction_without_wallet_debit`: a statement deduction with no matching wallet debit.
  - `balance_change_without_amount`: a +0/−0 row that changes the balance.
  - `row_arithmetic`: opening + penalty − deducted doesn't equal closing.
  - `wallet_debit_without_statement_row`: a wallet debit booked to this advance with no matching statement row on any of the agent's advances.
  - `statement_vs_outstanding`: the statement's last closing balance doesn't equal `outstanding_balance` (skipped for cancelled advances).

## Verified results (29 Sep)

| Advance | Result |
|---|---|
| Ian `ba37593d` (cleaned in doc 150) | **Reconciled, 0 issues.** Statement 2,906,327.92 = wallet 2,906,327.92 |
| Okwakol `8977ca67` | 4 issues: a +4,815 jump on 19 Jul; a −46,551 jump on 22 Aug (the `advance_interest_removal` of 21 Aug); the fake 214,433 deduction on 9 Sep; the +0/−0 reinstatement on 27 Sep |
| Okwakol `1fb74a3d` (completed May advance) | Wallet = statement (1,313,278). 1 issue: marked `completed` on 29 Jul while the statement still ends at 316,581 |

Across all **326 open advances: 196 reconcile, 130 have issues.**

| Issue | Occurrences | Advances | Net amount (UGX) |
|---|---|---|---|
| `balance_jump` | 145 | 119 | −1,479,365 |
| `deduction_without_wallet_debit` | 36 | 19 | 1,846,617 |
| `wallet_debit_without_statement_row` | 32 | 13 | 1,808,183 |
| `balance_change_without_amount` | 5 | 5 | 2,215,808 |
| `row_arithmetic` | 1 | 1 | −414,258 |
| `statement_vs_outstanding` | 1 | 1 | 133,000 |

None of these have been corrected. Each is an individual CFO call, as Ian's was.

## Gotchas
- Not in `types.ts` yet, so it's called as `rpc('…' as any)`, the same as `useActualMoneyHeld`. Lovable regenerates the types on deploy.
- Timestamps are shown in the viewer's local time; days are grouped by Africa/Kampala date.
