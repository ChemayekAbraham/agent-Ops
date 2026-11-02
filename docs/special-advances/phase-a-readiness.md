# Special Advances readiness, Phase A (unblock)

Status as at 2026-11-02. Phase A is the first step of the readiness plan the CFO approved on 2026-11-02 ("Start Phase A
only"). Nothing in this phase is applied to production, pushed or deployed without a further explicit CFO go-ahead.
Issuance stays switched off.

Production facts (read-only, 2026-11-02): Phases 1-4 applied; issuance off; no advances; the proof bucket
`special-advance-proofs` exists (private, 10 MB, JPEG / PNG / WebP / PDF, empty) but **no storage policy reaches it**, so
every upload is refused; **0 of the 4 enabled CFOs (0 users in total) have a verified authenticator**; the global
`staff_mfa_config.mode` is `shadow`.

## CFO decisions recorded 2026-11-02

| # | Decision | Applies in |
|---|---|---|
| D14 | Reading and uploading a proof file need a session verified with the authenticator app (JWT `aal` = `aal2`), independent of the global staff MFA mode, as approval, payout and repayment already do (D5) | Phase A: `20261028153100` (not applied yet) |
| D7 | Impairment minimum provision by days past due: current 0%, 1-30 days 10%, 31-60 days 25%, 61-90 days 50%, over 90 days 100%; the CFO may provide more on individual assessment | Phase C (not built yet) |

The other readiness decisions (D6, D8-D13) are proposals only and are not approved.

## What Phase A changes (code on `sarah-dev`)

1. **An advance is a receivable only once paid out.** Migration
   `supabase/migrations/20261102200000_special_advances_receivable_after_payout.sql` replaces only
   `_special_advance_position`. Before payout (pending approval, approved, rejected, cancelled) every outstanding figure
   is 0; new fields `paid_out` and `scheduled_outstanding` (the agreed schedule still unpaid) are added. After payout
   the figures are exactly as before. The A24 reconciliation, payout and repayment are unchanged. Preflight pins the
   production definition (md5 `2a4a08a6…`); rollback restores it verbatim. Not applied.
2. **D14** in `supabase/migrations/20261028153100_special_advances_proof_storage_policies.sql` (not applied): both
   policies also require `aal2`.
3. `src/lib/specialAdvances.ts`: the position type carries the two new optional fields.
4. Tests: `src/test/specialAdvancePayout.test.ts` ("Receivable only after payout (Phase A)" and the D14 checks in the
   storage-policy test). Special Advances suite: 213/213.

## Project owner: apply the proof storage policies

Only the owner of `storage.objects` (`supabase_storage_admin`) can create these; the CLI's `postgres` login cannot
(production: `postgres` is not a member). The asset register's policies were created the same way on 2026-10-26.

1. Supabase dashboard, project `byrzshwlentqvktcksem` → **Storage → Policies** → bucket **special-advance-proofs** →
   **New policy → For full customization**.
2. Policy 1. Name `special_advance_proofs_read`; operation **SELECT**; target role **authenticated**; USING:
   ```sql
   bucket_id = 'special-advance-proofs' AND (select public.special_advance_cfo_ok()) AND (select public.staff_mfa_ok()) AND (select auth.jwt() ->> 'aal') = 'aal2'
   ```
3. Policy 2. Name `special_advance_proofs_insert`; operation **INSERT**; target role **authenticated**; WITH CHECK:
   ```sql
   bucket_id = 'special-advance-proofs' AND name ~ '^advances/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|pdf)$' AND (select public.special_advance_cfo_ok()) AND (select public.staff_mfa_ok()) AND (select auth.jwt() ->> 'aal') = 'aal2'
   ```
4. Do **not** add an UPDATE or DELETE policy.
5. Tell Claude when done. Claude then checks read-only that both policies match the file character for character and
   that no other policy reaches the bucket, updates the file to the names the dashboard gave them (it may add a
   suffix, as it did for the asset register), and records the marker row in `supabase_migrations.schema_migrations`
   with CFO approval.

Before step 1, check that **Authentication → Multi-Factor → TOTP (App authenticator)** is enabled for the project
(not verifiable from SQL). Without it nobody can enrol.

## Gemini (UI) hand-off

Logic is in place; these are screens only. Copy must say "Special Advance", "access fee", "registration fee" (never
loan, lender, interest or ROI).

1. **Authenticator enrolment (blocking).** No screen in the app uses `useAuthenticatorMfa`
   (`src/hooks/useAuthenticatorMfa.ts`), so nobody can enrol today. Build the enrol screen per
   `docs/security/mfa-ui-handoff.md` and `docs/security/mfa-screens-brief.md`: `startEnrol()` returns `qrSvg` and
   `secret` to show; `verifyEnrol(code)` confirms. In `shadow` mode the hook reports `prompt` for a staff member without
   an authenticator; offer the setup from there (e.g. account settings) so CFOs can enrol.
2. **Step-up in the Special Advances screens.** Approve, pay out and record repayment return `MFA_REQUIRED` for a
   password-only session (`specialAdvanceErrorText` already words it). On that error, ask for the 6-digit code, call
   `verifyChallenge(code)` from the hook, then retry the same request with the same idempotency key. Note: in `shadow`
   mode the hook's `stage` is `not_required` for an enrolled CFO even when the session is password-only, so key the
   prompt off the server error (or `supabase.auth.mfa.getAuthenticatorAssuranceLevel()`), not off `stage`. Proof
   uploads also need `aal2` (D14): verify before showing the upload control, or prompt on the storage error.
3. **Proof upload.** `PayoutForm` (external borrowers) and `RepaymentForm` in
   `src/components/cfo/special-advances/SpecialAdvanceDetailSheet.tsx` need a file control (JPEG, PNG, WebP or PDF, at
   most 10 MB: `SPECIAL_ADVANCE_PROOF_TYPES`, `SPECIAL_ADVANCE_PROOF_MAX_BYTES`) that calls
   `uploadSpecialAdvanceProof(advance.id, file)` and sends the returned path as `proof_path`. Without it the server
   refuses every external payout and repayment (`PROOF_REQUIRED`). Show the proof on the detail sheet (signed URL from
   the private bucket) for the payout and each repayment.
4. **Outstanding before payout.** Once `20261102200000` is applied, `position.outstanding` is 0 before payout. On the
   detail sheet, when `position.paid_out === false`, label the figure so it does not read as money owed, e.g. show
   "Repayable after payout: {scheduled_outstanding}" instead of "Outstanding". Treat a missing `paid_out` as the old
   server (show as today).

## Before Phase B

Phase A is done when: the storage policies are applied and verified; TOTP is enabled and the CFOs who will act have
enrolled; the step-up, proof upload and outstanding display are in the screens; `20261102200000` is applied with CFO
approval and verified read-only. Issuance stays off until Phases A, B and E are complete (proposal D13, not approved).
