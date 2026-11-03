# Special Advances readiness, Phase B: corrections

Status as at 2026-11-02: built on `sarah-dev`, **not applied** to production. Production apply needs explicit CFO
approval. Migration `supabase/migrations/20261102210000_special_advances_corrections.sql`, rollback
`supabase/rollbacks/20261102210000_special_advances_corrections.rollback.sql`, tests
`src/test/specialAdvanceCorrections.test.ts`.

## CFO decisions D11 (2026-11-02)

| # | Decision |
|---|---|
| D11a | A correction posts **new** ledger legs: the same `special_advance_*` categories in the opposite direction, `source_table = 'special_advance_corrections'`, linked to the original. No new account, mapping or allowlist entry. Nothing posted is ever edited or deleted. |
| D11b | **One step (CFO decision 2026-11-03).** Welile has one CFO, who records and posts a correction in a single authorised action: enabled CFO role, checked by the server (no authenticator since 2026-11-03). There is no pending state, queue, approval, rejection or withdrawal. (This replaces the request-then-approve design of 2026-11-02.) |
| D11c | Scope: (1) reverse an erroneous repayment, on a paid-out or settled advance (a settled one reopens); (2) reverse an **external** payout recorded in error, once every repayment on it has been reversed (the advance ends `reversed`). A payout to a Welile wallet cannot be reversed here. |
| D11d | Every correction carries a reason (20-1000 characters) and an archived proof file in the private bucket (this advance's folder, must exist, used once across payouts, repayments and corrections). |

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

- New table `special_advance_corrections` (reference `SAC-000001`): append-only, one row per posted correction, written
  in the same transaction as its ledger group (`ledger_group_id` always set); never updated or deleted; the recorder
  must be an enabled CFO (`_special_advance_guard_posted`); RLS CFO read + staff-MFA policy; no client writes. A
  repayment is reversed at most once and a payout at most once (unique indexes).
- New function (authenticated only; CFO check inside): `special_advance_record_correction(p_id, p_request)` — checks
  everything against the records as they are now, posts the opposite legs once (ledger key
  `special_advance:correction:<id>`), writes the record and the `correction_posted` event, all in one transaction. A
  retry with the same `idempotency_key` and the same request returns the posted correction (`replayed: true`); the
  same key with a different request is refused (`IDEMPOTENCY_CONFLICT`).
- `special_advance_repayments.reversed_by_correction`: stamped once by the posted reversal of that repayment; the only
  change ever allowed to a repayment row. A reversed repayment's allocations stop counting, and its provider reference
  may be recorded again (for example against the right advance).
- Status edges: `settled -> disbursed` (reopened) and `disbursed -> reversed` (external only), only from inside a
  posted correction. Events: `correction_posted`, `reopened`, `reversed`.
- Replaced (each pinned to its production md5 by the preflight): `_special_advance_guard_update`,
  `_special_advance_audit`, `_special_advance_position`, `_special_advance_verify_repayments`,
  `_special_advance_check_proof`, `special_advance_record_repayment`, `special_advance_statement` (adds `corrections`
  and `reversed_by_correction`), `special_advance_reconciliation` (follows correction legs; a reversed advance must
  stand at 0).
- Client: `src/lib/specialAdvances.ts` (types, labels, `buildCorrectionRequest`, messages) and
  `src/hooks/useSpecialAdvances.ts` (`useRecordSpecialAdvanceCorrection`).

Refusals (nothing is posted or recorded): `REPAYMENT_ALREADY_REVERSED`, `REPAYMENTS_MUST_BE_REVERSED_FIRST`,
`PAYOUT_REVERSAL_NOT_SUPPORTED` (wallet payout), `SPECIAL_ADVANCE_NOT_CORRECTABLE`, `BORROWER_HAS_OPEN_ADVANCE`
(reopening would give a borrower two open advances), `SELF_ADVANCE`, `IDEMPOTENCY_CONFLICT`, plus the proof, reason,
MFA and role checks.

## Screens

1. **Correct** (detail sheet): on each repayment that stands, "Reverse this repayment"; on an external advance with no
   standing repayment, "Reverse the payout". Form: reason (min `CORRECTION_REASON_MIN` = 20) and proof file; the
   one confirm uploads the file and posts it (`useRecordSpecialAdvanceCorrection` with
   `buildCorrectionRequest(...)` and a `newIdempotencyKey()` reused only for a retry of the same request).
2. **Detail sheet**: list `statement.corrections` (posted by, when, reason, proof); show a repayment with
   `reversed_by_correction` as reversed (struck through, not counted). The events list shows `correction_posted`.
3. There is no correction queue and no approve / reject / withdraw step.

## Before applying

Phase A storage policies applied (proof uploads), CFO approval to apply.
Issuance stays off.
