# Special Advances readiness, Phase C: impairment, write-off and recovery

Status as at 2026-11-02: built on `sarah-dev`, **not applied** to production. Requires Phase B
(`20261102210000`) first. Production apply needs explicit CFO approval; it changes the accounting policy (new account
A25, six mapping rows, six allowlisted categories) and changes no existing account, mapping, category or posting.
Migration `supabase/migrations/20261102220000_special_advances_impairment_writeoff.sql`, rollback
`supabase/rollbacks/20261102220000_special_advances_impairment_writeoff.rollback.sql`, tests
`src/test/specialAdvanceImpairment.test.ts`.

## CFO decisions (2026-11-02)

| # | Decision |
|---|---|
| D7 | Minimum allowance by days past due (oldest unpaid instalment past its due date): current 0%, 1-30 days 10%, 31-60 days 25%, 61-90 days 50%, over 90 days 100%. The CFO may set a **higher** individual rate per advance (never lower); it carries forward until changed (0 returns to the minimum). |
| D8 | A24 stays the gross receivable. New contra-asset **A25 Special Advances — Impairment Allowance** (credit balance); expense to the existing **X4 Credit Losses and Write-offs**, identifiable by category. A25 reports under Other Assets with A24, so the group shows the net receivable. |
| Provisions | A CFO runs a review; the server computes each paid-out advance's required allowance on its gross outstanding (principal + unpaid fees) and proposes the difference; a **different** CFO approves. On approval every figure is recomputed and the review is refused as stale if anything moved. One review pending at a time. |
| D9 | Write-off: reason (20-1000 characters) + archived evidence file; a **different** CFO approves. The whole gross outstanding leaves A24; the allowance held is used (DR A25) and any remainder goes to X4; an allowance above the balance is released (CR X4). Past revenue (R1) is left as reported. The advance ends `written_off` (terminal); its history stays. |
| D10 | Recovery after write-off: DR A1 / CR X4, recorded by a CFO with reference + proof (aal2); never more than was written off; the advance stays written off. |

**Safety default (not a recorded decision; flagged for the CFO):** a borrower with a written-off Special Advance is
refused a new one (`WRITTEN_OFF_SPECIAL_ADVANCE`), like the existing overdue / defaulted checks.

## Journal entries (UGX, from the tests)

| Event | DR | CR |
|---|---|---|
| Provision, 10 days past due (10% of 940,000) | X4 94,000 | A25 94,000 |
| Individual rate 60% on the same advance | X4 470,000 | A25 470,000 |
| Back to the minimum (release) | A25 470,000 | X4 470,000 |
| Write-off of 940,000 with 94,000 held | A25 94,000; X4 846,000 | A24 940,000 |
| Write-off of 299,000 with 378,000 held (over-provided) | A25 378,000 | A24 299,000; X4 79,000 |
| Recovery of 300,000 after write-off | A1 300,000 | X4 300,000 |

Every group nets to zero raw and balances on base mapping; all legs are platform scope (no wallet moves). Production's
resolver (`sofp_ledger_legs`, loaded verbatim) resolves every Special Advances group through Phase C exactly as base
mapping, with no E4 leg (local check, 14 groups, trial balance DR = CR). Provisions and write-offs are dated on the day
of approval; recoveries on the day received.

## Reconciliation

`special_advance_reconciliation()` now also returns `a25_ledger_balance` (the allowance, CR - DR), `allowance_subledger`
(approved provision movements less allowance released by write-offs), `allowance_difference`, `net_receivable`
(A24 - A25) and `mismatched_allowances`. `balanced` requires A24 and A25 both to tie, in total and per advance.

## What changes

- Tables (RLS CFO read + staff-MFA policy; no client writes): `special_advance_provision_reviews` (`SAP-000001`),
  `special_advance_provision_lines` (the ledger group is stamped once on approval), `special_advance_write_offs`
  (`SAW-000001`, one open per advance), `special_advance_recoveries` (append-only).
- Functions (authenticated only; CFO + aal2 inside): `special_advance_provision_preview`, `special_advance_request_provision_review`,
  `special_advance_decide_provision_review`, `special_advance_list_provision_reviews`, `special_advance_request_write_off`,
  `special_advance_decide_write_off`, `special_advance_list_write_offs`, `special_advance_record_recovery`.
- Status `written_off` (edge `disbursed -> written_off` only inside an approved write-off); events `written_off`,
  `write_off_requested / _approved / _rejected / _withdrawn`, `provision_posted`, `recovery_recorded`.
- Replaced (each pinned to its Phase B / production md5): `_special_advance_guard_update`, `_special_advance_audit`,
  `_special_advance_check_proof` (proof used once across every record), `_special_advance_eligibility`,
  `special_advance_statement` (allowance, provision, history, write-offs, recoveries), `special_advance_reconciliation`.
- Client: `src/lib/specialAdvances.ts`, `src/hooks/useSpecialAdvances.ts`, `src/components/cfo/balanceSheetClassification.ts` (A25).

## Gemini (UI) hand-off

1. **Provision review** (CFO dashboard): `useSpecialAdvanceProvisionPreview` shows each line (days past due, minimum,
   individual rate, required, held, change); the CFO may enter a higher individual rate per advance; submit with
   `useRequestProvisionReview(buildProvisionReviewRequest(...))`. Queue for the second CFO:
   `useSpecialAdvanceProvisionReviews('pending')`, buttons from `correctionActions(review, userId)`. Explain the
   minimums with `IMPAIRMENT_MINIMUMS`.
2. **Write-off** (detail sheet, paid-out advance): reason + evidence upload, `useRequestSpecialAdvanceWriteOff`;
   queue `useSpecialAdvanceWriteOffs('pending')`, decide with `useDecideSpecialAdvanceWriteOff`.
3. **Recovery** (detail sheet, written-off advance): same form as a repayment, `useRecordSpecialAdvanceRecovery`.
4. **Detail sheet**: show `allowance_held`, net (outstanding - allowance), `provision_history`, `write_offs`,
   `recoveries`; add `written_off` to the terminal-status line.
5. **Reconciliation tile**: gross (A24), allowance (A25), net receivable; flag `mismatched_allowances`.

## Before applying

Phase B applied first; the CFO approves the accounting-policy change; the CFO enrolled with an authenticator (the same CFO approves their own requests, amended 2026-11-03). Issuance
stays off.
