# Special Advances readiness, Phase B: corrections

Status as at 2026-11-02: built on `sarah-dev`, **not applied** to production. Production apply needs explicit CFO
approval. Migration `supabase/migrations/20261102210000_special_advances_corrections.sql`, rollback
`supabase/rollbacks/20261102210000_special_advances_corrections.rollback.sql`, tests
`src/test/specialAdvanceCorrections.test.ts`.

## CFO decisions D11 (2026-11-02)

| # | Decision |
|---|---|
| D11a | A correction posts **new** ledger legs: the same `special_advance_*` categories in the opposite direction, `source_table = 'special_advance_corrections'`, linked to the original. No new account, mapping or allowlist entry. Nothing posted is ever edited or deleted. |
| D11b | Maker-checker: one enabled CFO requests; a **different** enabled CFO approves or rejects (rejection needs a note). Nothing posts until approval. The requester may withdraw. Both steps need an authenticator-verified session (aal2). |
| D11c | Scope: (1) reverse an erroneous repayment, on a paid-out or settled advance (a settled one reopens); (2) reverse an **external** payout recorded in error, once every repayment on it has been reversed (the advance ends `reversed`). A payout to a Welile wallet cannot be reversed here. |
| D11d | Every request carries a reason (20-1000 characters) and an archived proof file in the private bucket (this advance's folder, must exist, used once across payouts, repayments and corrections). |

## Journal entries (UGX)

| Correction | DR | CR |
|---|---|---|
| Reverse a repayment of 200,000 | A24 200,000 | A1 200,000 |
| Reverse an external payout of 300,000 with fees 45,000 + 20,000 | A1 300,000; R1 65,000 | A24 365,000 |

Each group nets to zero raw and balances on the existing mapping. Production's resolver (`sofp_ledger_legs`, loaded
verbatim) resolves every Special Advances group (payouts, repayments, corrections) exactly as base mapping, with no E4
leg (local check, 2026-11-02). A1 legs flow into `get_treasury_cash_position` as usual. Corrections are dated on the
day of approval; the original entries keep their dates.

## What changes

- New table `special_advance_corrections` (reference `SAC-000001`; pending -> approved / rejected / withdrawn, decided
  once; no update after, no delete; RLS CFO read + staff-MFA policy; no client writes).
- New functions (authenticated only; CFO + aal2 inside): `special_advance_request_correction(p_id, p_request)`,
  `special_advance_decide_correction(p_correction_id, p_decision, p_note)`,
  `special_advance_list_corrections(p_status, p_limit)`.
- `special_advance_repayments.reversed_by_correction`: stamped once by an approved reversal; the only change ever
  allowed to a repayment row. A reversed repayment's allocations stop counting, and its provider reference may be
  recorded again (for example against the right advance).
- Status edges: `settled -> disbursed` (reopened) and `disbursed -> reversed` (external only), only from inside an
  approved correction. Events: `correction_requested / _approved / _rejected / _withdrawn`, `reopened`, `reversed`.
- Replaced (each pinned to its production md5 by the preflight): `_special_advance_guard_update`,
  `_special_advance_audit`, `_special_advance_position`, `_special_advance_verify_repayments`,
  `_special_advance_check_proof`, `special_advance_record_repayment`, `special_advance_statement` (adds `corrections`
  and `reversed_by_correction`), `special_advance_reconciliation` (follows correction legs; a reversed advance must
  stand at 0).
- Client: `src/lib/specialAdvances.ts` (types, labels, `buildCorrectionRequest`, `correctionActions`, messages) and
  `src/hooks/useSpecialAdvances.ts` (`useSpecialAdvanceCorrections`, `useRequestSpecialAdvanceCorrection`,
  `useDecideSpecialAdvanceCorrection`).

Refusals: `SECOND_CFO_REQUIRED`, `ONLY_REQUESTER_MAY_WITHDRAW`, `CORRECTION_ALREADY_PENDING` (one pending per advance),
`CORRECTION_ALREADY_DECIDED`, `REPAYMENT_ALREADY_REVERSED`, `REPAYMENTS_MUST_BE_REVERSED_FIRST`,
`PAYOUT_REVERSAL_NOT_SUPPORTED` (wallet payout), `SPECIAL_ADVANCE_NOT_CORRECTABLE`, `BORROWER_HAS_OPEN_ADVANCE`
(reopening would give a borrower two open advances), plus the proof, reason, MFA and role checks.

## Gemini (UI) hand-off

Logic is in place; these are screens only.

1. **Request a correction** (detail sheet): on each repayment that stands, "Reverse this repayment"; on an external
   advance with no standing repayment, "Reverse the payout". Form: reason (min `CORRECTION_REASON_MIN` = 20), proof
   file via `uploadSpecialAdvanceProof(advance.id, file)`, then `useRequestSpecialAdvanceCorrection` with
   `buildCorrectionRequest(...)` and a fresh `newIdempotencyKey()` (reuse it only for a retry).
2. **Correction queue** for the second CFO: `useSpecialAdvanceCorrections('pending')`. Buttons from
   `correctionActions(correction, currentUserId)`: approve / reject (reject needs a note) for another CFO, withdraw for
   the requester. Use `CORRECTION_KIND_LABEL` / `CORRECTION_STATUS_LABEL`. Show the proof file (signed URL).
3. **Detail sheet**: list `statement.corrections`; show a repayment with `reversed_by_correction` as reversed (struck
   through, not counted). Add `reversed` to the terminal-status line (`SpecialAdvanceDetailSheet.tsx:70`). The events
   list shows the new event types.
4. Approve / reject / withdraw and requests return `MFA_REQUIRED` for a password-only session: same step-up as Phase A.

## Before applying

Phase A storage policies applied (proof uploads), at least two CFOs enrolled with an authenticator (maker-checker
needs two), CFO approval to apply. Issuance stays off.
