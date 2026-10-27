# Special Advances Phase 4: CFO decisions

Status as at 2026-10-27: Phases 1-3 are applied to production and verified; issuance is switched off; production holds
no advances. Phase 4 (`supabase/migrations/20261028153000_special_advances_payout_repayment.sql`, payout, repayment
and reconciliation) is **not applied**. Every item below describes what the Phase 4 code on `sarah-dev` does today. None
of these policies has been changed to anything the CFO has not decided; the open items need an explicit decision before
Phase 4 is applied.

| # | Decision | Phase 4 code today | Status |
|---|---|---|---|
| D1 | External payout evidence | Method + reference **and an archived proof file** required; posted from A1 | **Decided 2026-10-27: proof required** |
| D2 | Repayment evidence | Method + reference **and an archived proof file** required; posted to A1 | **Decided 2026-10-27: proof required** |
| D3 | Fee recognition timing | Access and registration fees are revenue (R1) at payout | **Pending confirmation** |
| D4 | One person approves and pays out | Any enabled CFO may approve and pay out the same advance (not their own) | **Pending confirmation** |
| D5 | Staff MFA for money-moving actions | Approval, payout and repayment need an authenticator-verified session (aal2) | **Decided 2026-10-27: accepted** |
| D6 | Balance-sheet heading for A24 | Reported under "Other Assets" | **Implemented, open to change** |

Already decided by the CFO (2026-10-27) and implemented: payout to a Welile borrower goes to their withdrawable wallet;
an external borrower is paid off-platform; repayments are recorded by the CFO only (no wallet sweeps); no late fee;
an overpayment is refused; early settlement pays the full agreed total. Account A24 (not A20, which production already
uses for agent advance registration fees) is the Special Advances receivable.

## D1. Evidence for an external payout

**Today.** `special_advance_disburse` for an external borrower requires a method (`mobile_money` or `bank_transfer`)
and a transaction reference of 3-100 characters. It posts DR A24 / CR A1 straight away. No provider receipt, statement
or Receipt Archive check is required, and the reference is not checked against any provider record.

**Risk.** Company cash (A1) is recorded as paid out on the CFO's word. A mistyped or false reference is not detected.
This differs from the receipt-based rule the CFO set for landlord payouts (a payout counts as paid only when an
archived receipt proves it).

**Options.**
1. Keep as is: the CFO's recorded reference is the evidence (fastest; relies on CFO controls).
2. Require an archived proof (receipt / statement upload) before the payout can be recorded; reject without it.
3. Record the payout as "paid, unverified" and treat it as verified only once a receipt is archived and matched, as
   the landlord payout rule does.

**Decision (CFO, 2026-10-27): require an archived proof (option 2).** See "Proof files: what is implemented" below.

## D2. Evidence for a repayment

**Today.** `special_advance_record_repayment` requires a method (`mobile_money` or `bank_transfer`, no cash), a
reference that has never been used before for that method, a received date between payout and today, and an amount no
more than what is outstanding. It posts DR A1 / CR A24 straight away. No provider statement or receipt is checked.

**Risk.** Cash is recognised in A1 on the CFO's word; a repayment recorded in error reduces the receivable and inflates
cash until reversed (reversal needs approved reversing entries; repayment records are append-only).

**Options.** As for D1: keep; require an archived proof; or record as unverified until matched.

**Decision (CFO, 2026-10-27): require an archived proof (option 2).** See "Proof files: what is implemented" below.

### Proof files: what is implemented (Phase 4 migration, not applied)

- Private bucket `special-advance-proofs` (10 MB; JPEG, PNG, WebP or PDF), created by the Phase 4 migration.
- A proof sits at `advances/<advance id>/<uuid>.<ext>`. `_special_advance_check_proof` refuses a missing proof
  (`PROOF_REQUIRED`), a path outside that advance's folder or of another type (`PROOF_PATH_INVALID`), a file that is not
  in the bucket (`PROOF_NOT_FOUND`) and a file already attached to a payout or repayment (`PROOF_ALREADY_USED`).
- External payout: `special_advance_disburse` requires the proof and records it in `special_advances.payout_proof_path`
  (written once, never changed; one proof per payout). A wallet payout is internal and refuses a proof.
- Repayment: `special_advance_record_repayment` requires the proof and records it in
  `special_advance_repayments.proof_path` (unique; repayments are append-only); the statement lists it.
- Every check runs before anything is posted, so a refused payout or repayment writes nothing.
- Storage policies (CFO-only read and upload, staff MFA; no update or delete): separate migration
  `20261028153100_special_advances_proof_storage_policies`. Only the owner of `storage.objects` can create them, so,
  like the asset register's, it must be applied by the project owner (Supabase dashboard); its preflight refuses the
  CLI's postgres login.
- App: `uploadSpecialAdvanceProof` (hook) uploads a file and returns its path; the payout and repayment calls accept
  `proof_path`; the screens explain each refusal.

### Proof files: still to do before Phase 4 is used

1. UI (Gemini): a file-upload control on the payout (external borrowers) and repayment forms that calls
   `uploadSpecialAdvanceProof` and sends the path; show the proof link on the detail sheet. Until then the server
   refuses external payouts and repayments from the screens (`PROOF_REQUIRED`).
2. Project owner applies `20261028153100` (storage policies) after Phase 4.
3. Not included: automatic reading of the proof (transaction ID / amount match) as the Receipt Archive does for
   landlord payouts. The proof is archived and attached, and the CFO's reference is recorded, but nothing checks that
   the file shows that reference and amount. The machine check (`payout_proof_ocr_log`) is keyed to withdrawal
   requests, so adding it means a separate log and edge-function work: a later decision (option 3).

## D3. When fees are recognised

**Today.** At payout the whole access fee and registration fee are recognised: DR A24 / CR R1 for each fee, in the
same ledger group as the payout. Repayments then only reduce A24. This mirrors how the existing advance products
recognise fees.

**Risk.** Revenue for the whole term is booked on day one. If a borrower defaults, revenue is overstated until a
write-off, and the receivable includes fees not yet earned.

**Options.**
1. Keep (consistent with existing advances).
2. Recognise the access fee over the term (deferred income released per instalment); registration fee at payout.
3. Recognise fees only as cash is received.

**Recommendation.** Confirm option 1 for consistency now, with option 2 considered for all advance products together.
No change made.

## D4. One person approves and pays out

**Today.** Approval (`special_advance_approve`, Phase 3) and payout (`special_advance_disburse`, Phase 4) are separate
steps, but the same enabled CFO may do both. Only a self-advance (a CFO paying themselves) is blocked. This follows the
CFO's "sole authority" decision; there are 4 enabled CFO accounts in production.

**Risk.** No second pair of eyes: one compromised or mistaken CFO account can approve and pay out an advance alone.

**Options.**
1. Keep: CFO sole authority.
2. Maker-checker: the CFO who approves cannot pay out the same advance (a second CFO pays out).
3. Maker-checker above a principal threshold only.

**Recommendation.** Option 2 or 3 if more than one person holds the CFO role in practice; otherwise D5 (MFA) is the
main safeguard. No change made.

## D5. Staff MFA for money-moving actions (DECIDED 2026-10-27: accepted)

**Finding (read-only, 2026-10-27).** Production `staff_mfa_config.mode` is `shadow`, so `staff_mfa_ok()` passes for
everyone and every Special Advances action works with a password-only session. **No user in production, including
the 4 CFOs, has a verified authenticator factor.** The app already supports enrolment and verification
(`src/hooks/useAuthenticatorMfa.ts`: enroll, challengeAndVerify, getAuthenticatorAssuranceLevel).

**Decision (CFO, 2026-10-27): accepted; in the Phase 4 migration, not yet applied.** Approval, payout and repayment recording require the
session's JWT `aal` to be `aal2` (verified with the authenticator app), independent of the global mode:
- `_special_advance_require_mfa()` raises `MFA_REQUIRED` (42501) for a signed-in caller without `aal2`;
- `special_advance_disburse` and `special_advance_record_repayment` call it first, before anything is posted;
- a trigger on `special_advances` calls it on the transitions to `approved` and `disbursed`, so the Phase 3
  approval function is guarded without being replaced;
- reject, cancel, quote, list, statement and reconciliation are unchanged; the CFO-only rule and every other check
  stay; the global `staff_mfa_config` is not touched;
- the screen shows "Verify with your authenticator app first…" for `MFA_REQUIRED`.

Tests: `src/test/specialAdvancePayout.test.ts`, describe "Staff MFA for money-moving actions".

**Consequence.** After Phase 4, no CFO can approve, pay out or record a repayment until they enrol an authenticator
and verify in the session. Issuance is off in any case. The step-up prompt in the Special Advances screens (calling
the existing MFA hook) is UI work still to do.

**Before Phase 4 is applied:** each CFO who will approve, pay out or record repayments enrols an authenticator app
(none had as at 2026-10-27), and the Special Advances screens get the step-up prompt (UI). The global
`staff_mfa_config` mode is not changed by this decision.

## D6. Balance-sheet heading for A24

**Today (implemented locally).** `src/components/cfo/balanceSheetClassification.ts` maps A24 to **Other Assets**.
Borrowers can be tenants, agents, other Welile users or external individuals and companies, so none of the
counterparty headings ("Receivables from Tenant / Agent / Landlord / Partner Products and Services") fits every
balance, and without a mapping A24 would show as "Unclassified — flagged for review". The drill-down still names the
account. A20-A23 keep their headings. Tests: `src/test/balanceSheetClassification.test.ts`.

**Alternative.** A dedicated "Special Advances Receivable" heading: a change to the statement's layout (presentation,
CFO / UI decision).
