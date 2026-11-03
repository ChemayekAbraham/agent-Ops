# Gemini handoff: Special Advances CFO screens (UI only)

Prepared 2026-11-02 from `sarah-dev` 3e628053ff plus the two helpers below. Copy this whole file to Gemini.

## Your role and limits
You own UI: JSX, layout, Tailwind, shadcn/ui, copy, loading/empty/error states, component tests.
Claude owns logic. Do NOT:
- write `supabase.rpc(...)`, `supabase.from(...)` or `supabase.storage...` calls in components (use the hooks below; if a hook is missing, ask Claude);
- edit `src/hooks/useSpecialAdvances.ts`, `src/hooks/useAuthenticatorMfa.ts`, `src/lib/specialAdvances.ts`, anything in `supabase/`, or `scripts/`;
- calculate any money figure in the browser (outstanding, fees, allowance, net, provision amounts) — show only what the server returns;
- send amounts the server computes (provisions, write-offs): the request builders below send rates, reasons and proof paths only;
- add accounting rules, change who may approve, or enable issuance.

Branch: cut `dev/special-advances-ui` from `origin/sarah-dev`. Do not push to `lovable`.

Terminology (mandatory): "Special Advance", "access fee", "registration fee", "repayment", "allowance"/"provision",
"write-off", "recovery". Never "loan", "lender", "interest" or "ROI".

## Read first
- `docs/special-advances/phase-a-readiness.md` — storage, step-up, proof upload, "repayable after payout"
- `docs/special-advances/phase-b-corrections.md` — corrections (D11)
- `docs/special-advances/phase-c-impairment.md` — provisions, write-offs, recoveries (D7-D10)
- `docs/special-advances/phase-d-reporting.md` — balance-sheet memo (no UI work)
- `docs/special-advances/phase-e-golive.md` — go-live order
- `docs/security/mfa-screens-brief.md`, `docs/security/mfa-ui-handoff.md` — authenticator screens
- Existing screens: `src/components/cfo/special-advances/SpecialAdvancesPanel.tsx`, `SpecialAdvanceDetailSheet.tsx`
  (`DecisionForm`, `PayoutForm`, `RepaymentForm`, `EVENT_TEXT`), `src/components/cfo/SpecialAdvanceModal.tsx`
- Patterns: `src/components/account/TwoFactorGate.tsx` (6-digit input), `src/test/specialAdvancesPanel.test.tsx` (mocking rpc in tests)

## Production state (design for it)
- Live now: Phases 1-4 and A. `position.paid_out` and `position.scheduled_outstanding` are returned. Issuance is OFF.
- NOT live yet: Phase B (corrections), C (provisions / write-offs / recoveries, A25), D (memo). Their functions return
  PostgREST `PGRST202` until applied. Every new section must detect this with `isMissingServerFunction(err)` and show a
  quiet "Not available yet" state — never an error toast or a crash. Statement fields from B/C (`corrections`,
  `allowance_held`, `provision`, `provision_history`, `write_offs`, `recoveries`, reconciliation `a25_*`) are optional:
  hide their sections when absent.
- Proof storage policies are not applied yet: uploads and viewing fail until the project owner applies them. Show
  "Proof files are not available yet" on a storage permission error.
- 0 of 4 CFOs have an authenticator: every money-moving action returns `MFA_REQUIRED` until they enrol.

## Hooks and helpers to use (all exist)
From `@/hooks/useSpecialAdvances`:
- reads: `useSpecialAdvanceList`, `useSpecialAdvanceStatement`, `useSpecialAdvanceReconciliation`,
  `useSpecialAdvanceCorrections(status)`, `useSpecialAdvanceProvisionPreview(request)`,
  `useSpecialAdvanceProvisionReviews(status)`, `useSpecialAdvanceWriteOffs(status)`
- writes: `useSpecialAdvanceDecision`, `useDisburseSpecialAdvance`, `useRecordSpecialAdvanceRepayment`,
  `useRequestSpecialAdvanceCorrection`, `useDecideSpecialAdvanceCorrection`, `useRequestProvisionReview`,
  `useDecideProvisionReview`, `useRequestSpecialAdvanceWriteOff`, `useDecideSpecialAdvanceWriteOff`,
  `useRecordSpecialAdvanceRecovery`
- files: `uploadSpecialAdvanceProof(advanceId, file)` → path; `getSpecialAdvanceProofUrl(path)` → 60-second signed URL

From `@/lib/specialAdvances`: `STATUS_LABEL`, `CORRECTION_KIND_LABEL`, `CORRECTION_STATUS_LABEL`,
`CORRECTION_REASON_MIN/MAX`, `IMPAIRMENT_MINIMUMS`, `SPECIAL_ADVANCE_PROOF_TYPES`, `SPECIAL_ADVANCE_PROOF_MAX_BYTES`,
`buildCorrectionRequest`, `buildProvisionReviewRequest`, `buildWriteOffRequest`,
`correctionActions(record, currentUserId)` (→ `['approve','reject']` for another CFO, `['withdraw']` for the requester,
`[]` once decided; use it for provision reviews and write-offs too), `describeSpecialAdvanceError(err)` (the ONLY source
of error text), `newIdempotencyKey()`, `isMissingServerFunction(err)`.

From `@/hooks/useAuthenticatorMfa`: `useAuthenticatorMfa(userId)` → `{ stage, enrol, busy, error, startEnrol,
verifyEnrol, verifyChallenge, refresh }`. From `@/hooks/useAuth`: the current user's id.

Idempotency: create ONE key per intended action with `newIdempotencyKey()`; reuse it for retries (including the retry
after step-up); make a new key only when the user changes the inputs (copy `RepaymentForm`'s `useEffect` pattern). A
response with `replayed: true` means "already recorded" — show the same success state, not an error.

## 1. Authenticator enrolment and step-up
a) Build what `docs/security/mfa-screens-brief.md` specifies: `AuthenticatorSetupScreen`, `AuthenticatorChallengeScreen`,
   `AuthenticatorPromptBanner`, `StaffAuthenticatorGate` mounted in `src/App.tsx` beside `ForceResetPasswordGate`, plus
   the DEV-only `?mfaPreview=` switch. Also add "Set up authenticator app" in account settings (`src/pages/Settings.tsx`)
   that opens the setup screen (staff see stage `prompt` while the server mode is `shadow`).
b) `SpecialAdvanceStepUpDialog` + a small UI wrapper used by every Special Advances action: when a mutation fails with a
   message containing `MFA_REQUIRED` (or a proof upload / view fails with a storage permission error while the session is
   not aal2), open a 6-digit dialog, call `verifyChallenge(code)`, and on success re-run the SAME request (same idempotency
   key, same proof path). If `verifyChallenge` reports no authenticator, show "Set up your authenticator app first" with
   a link to the setup screen. Trigger on the server error (or `supabase.auth.mfa.getAuthenticatorAssuranceLevel()` via
   the hook), NOT on `stage`: in shadow mode `stage` is `not_required` for an enrolled CFO on a password-only session.
   Actions that need aal2: approve, payout, record repayment, request / decide a correction, request / decide a provision
   review, request / decide a write-off, record a recovery, upload / view proofs. Reject / cancel an advance, quote, list,
   statement, reconciliation and provision preview do not.

Acceptance: an enrolled CFO on a password-only session clicks "Record repayment", sees the code dialog, enters the code,
and the repayment is recorded once (no second row; `replayed` honoured). A wrong code shows the hook's `error` and keeps
the dialog open.

## 2. Proof files
- Component `SpecialAdvanceProofInput`: accepts `SPECIAL_ADVANCE_PROOF_TYPES` (JPEG, PNG, WebP, PDF) up to
  `SPECIAL_ADVANCE_PROOF_MAX_BYTES` (10 MB); validates type and size before uploading; uploads on submit with
  `uploadSpecialAdvanceProof(advance.id, file)` and passes the returned path; keeps that path for retries; a new file →
  new upload and new idempotency key.
- Where proof is REQUIRED: external payout (`PayoutForm` when `borrower_kind === 'external'`; a wallet payout must NOT
  send a proof), every repayment, every correction request, every write-off request, every recovery.
- Viewing: a "View proof" link fetches a signed URL with `getSpecialAdvanceProofUrl(path)` on click and opens it in a new
  tab. Never build public URLs; never prefetch. Show it for `payout_proof_path`, `repayments[].proof_path`,
  `corrections[].proof_path`, `write_offs[].proof_path`, `recoveries[].proof_path`.
- Errors via `describeSpecialAdvanceError`: `PROOF_REQUIRED`, `PROOF_PATH_INVALID`, `PROOF_NOT_FOUND`, `PROOF_ALREADY_USED`.

Acceptance: none of these submissions is possible without a file; an oversized or wrong-type file is refused before
upload; viewing uses a fresh signed URL each click.

## 3. Corrections (maker-checker, D11)
- Detail sheet: on each standing repayment of a paid-out or settled advance, "Reverse this repayment"; on an EXTERNAL
  advance in status `disbursed` with no standing repayment, "Reverse the payout" (a wallet payout shows no payout-reversal
  option). Form: reason (`CORRECTION_REASON_MIN`-`MAX` characters, counter) + proof file → `useRequestSpecialAdvanceCorrection`
  with `buildCorrectionRequest`.
- "Awaiting a second CFO" section in `SpecialAdvancesPanel` listing pending corrections
  (`useSpecialAdvanceCorrections('pending')`): reference (SAC-…), advance, kind (`CORRECTION_KIND_LABEL`), amount,
  reason, requested by / when, proof link. Buttons from `correctionActions(c, currentUserId)`: approve, reject (note
  required, 5-1000 characters), withdraw.
- Detail sheet history: list `statement.corrections` with `CORRECTION_STATUS_LABEL`, decider and note; show a repayment
  with `reversed_by_correction` struck through as "Reversed (SAC-…)" and not counted; add `reversed` and `written_off` to
  the "No further action" status line.
- Do not show approve / reject to the requester (the server refuses with `SECOND_CFO_REQUIRED` anyway).

Acceptance: the requester sees only Withdraw; another CFO sees Approve / Reject; reject without a note is blocked; after
approval the advance figures refresh from the server.

## 4. Provisions, write-offs and recoveries (D7-D10)
- Provision review (new "Provisions" tab / section in `SpecialAdvancesPanel`): show `useSpecialAdvanceProvisionPreview`'s
  lines — reference, gross outstanding, days past due, minimum rate, individual rate, applied rate, required allowance,
  held, change (positive = raise, negative = release) — and totals from the server. Explain minimums with
  `IMPAIRMENT_MINIMUMS`. Optional individual-rate input per line (higher than the minimum, or 0 to return to it), sent
  ONLY as `individual_rates` via `buildProvisionReviewRequest`. Submit → `useRequestProvisionReview`. Handle
  `NOTHING_TO_PROVISION` ("Every allowance already matches; nothing to post") and `PROVISION_REVIEW_ALREADY_PENDING`.
  Pending reviews in "Awaiting a second CFO" with their lines; decide with `useDecideProvisionReview`;
  `PROVISION_REVIEW_STALE` → "balances changed; reject or withdraw and run a new review".
- Write-off (detail sheet, paid-out advance with a balance): reason (≥ 20 characters) + evidence file →
  `useRequestSpecialAdvanceWriteOff` with `buildWriteOffRequest`. Show the server's `gross_amount`,
  `allowance_released`, `net_loss` (negative = excess allowance released). Decide in "Awaiting a second CFO"
  (`useDecideSpecialAdvanceWriteOff`); handle `WRITE_OFF_STALE`.
- Recovery (written-off advance only): same fields as a repayment (amount, date, method, reference, proof) →
  `useRecordSpecialAdvanceRecovery`; handle `RECOVERY_EXCEEDS_WRITTEN_OFF`, `REPAYMENT_REFERENCE_ALREADY_RECORDED`.
- Detail sheet: allowance held (`allowance_held`), current required provision (`provision`), `provision_history`,
  `write_offs`, `recoveries`.

Acceptance: no provision or write-off amount is typed or computed in the browser; every figure shown comes from the hook
response.

## 5. Figures — A24, A25, net receivable
- Detail sheet: when `position.paid_out === false`, label the figure "Repayable after payout" with
  `scheduled_outstanding` (never "Outstanding"); when `paid_out` is missing (older server), show as today. When paid out:
  "Outstanding" = `position.outstanding`; with Phase C also "Allowance" = `allowance_held` and "Net" from the server's
  figures only (if no per-advance net is returned, show outstanding and allowance; do not subtract).
- Reconciliation tile (`useSpecialAdvanceReconciliation`): A24 ledger vs records (`a24_ledger_balance`,
  `subledger_outstanding`, `difference`); with Phase C, A25 allowance vs subledger (`a25_ledger_balance`,
  `allowance_subledger`, `allowance_difference`) and `net_receivable`; balanced / unbalanced badge from `balanced`; list
  `mismatched_advances` and `mismatched_allowances` when present.
- Balance-sheet memo (Phase D) needs no change: `BalanceSheetPanel` already lists memo lines.

Acceptance: an approved-but-unpaid advance never shows money owed; tile figures equal the server response exactly.

## 6. States
- Loading: skeletons for list, statement, queues, preview; buttons disabled + spinner while a mutation is pending; no
  double submit.
- Empty: "No Special Advances yet", "Nothing awaiting a second CFO", "No provisions posted".
- Errors: always `describeSpecialAdvanceError(err)`; missing server function → "Not available yet"; `NOT_AUTHORIZED` →
  "Only an enabled CFO can do this" (no retry); storage permission → "Proof files are not available yet" or step-up.
- Permission: the Special Advances tab stays CFO-only as today; do not add role checks that differ from the server.
- Audit history: extend `EVENT_TEXT` with `reopened`, `reversed`, `correction_requested / _approved / _rejected /
  _withdrawn`, `written_off`, `write_off_requested / _approved / _rejected / _withdrawn`, `provision_posted`,
  `recovery_recorded`; show actor and time. Events in one transaction can share a timestamp — keep the server's order.
- Mobile first, light and dark theme, labelled inputs, `autocomplete="one-time-code"` on code inputs.

## Tests (vitest + React Testing Library; mock `supabase.rpc` / `supabase.storage` as `src/test/specialAdvancesPanel.test.tsx` does)
- Step-up: `MFA_REQUIRED` opens the dialog; `verifyChallenge` success retries with the same idempotency key and proof
  path; a wrong code keeps the dialog open; no authenticator → setup link.
- Proofs: wrong type / size refused before upload; external payout, repayment, correction, write-off, recovery cannot
  submit without a file; a wallet payout sends no `proof_path`; "View proof" calls `getSpecialAdvanceProofUrl` on click only.
- Corrections: requester sees Withdraw only; another CFO sees Approve / Reject; reject needs a note; reversed repayments
  render struck through; payout reversal not offered for a wallet payout or while a repayment stands.
- Provisions: preview renders server lines; request body contains only `individual_rates`, `note`, `idempotency_key`;
  `NOTHING_TO_PROVISION` and `PROVISION_REVIEW_STALE` messages.
- Write-off / recovery: request body has no amount for a write-off; `RECOVERY_EXCEEDS_WRITTEN_OFF` message; recovery
  offered only on `written_off`.
- Figures: `paid_out: false` shows "Repayable after payout"; the tile shows A25 / net rows only when returned.
- Missing functions: `PGRST202` from any Phase B/C function shows "Not available yet", not a toast.
- Existing suites still pass: `npx vitest run src/test/specialAdvance* src/test/specialAdvancesPanel.test.tsx
  src/test/cfoDashboardSpecialAdvances.test.tsx src/test/balanceSheetClassification.test.ts`, and `npm run guard:all`.

## Done when
All sections built with their states and tests on `dev/special-advances-ui`; nothing outside UI files changed (except new
UI test files); no new rpc / storage calls in components; terminology rules hold; screens checked at phone width in both
themes. Hand back to Claude for review before any merge.
