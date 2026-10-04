# 112 — Landlord payout flow now pays only the number Landlord Ops actually approved

**Built and applied live 2026-09-22. Supersedes doc 111's "lock to the number on file" fix —
"on file" and "Ops-approved" were not the same thing.**

## What was reported

After doc 111 shipped (lock the payout phone field, stop trusting the client), Josh: "A number
that is approved by Landlord Ops is the number that should be prefilled there." Doc 111's fix
locked the field to `landlords.mobile_money_number || phone` for verified landlords — which is
not actually the number Ops approved, it's just whatever happens to be sitting on the row.

## What was found

`verification_status='verified'` and `landlords.mobile_money_number`/`phone` are — and always
have been — completely decoupled:

- `set_landlord_verification()` (the only RPC that can mark a landlord verified) never touched
  `mobile_money_number`/`phone` at all. Approving a `landlord_verification_requests` row (which
  does carry a proposed `landlord_phone`) never wrote that phone anywhere — it only flipped the
  status flag.
- `mobile_money_number`/`phone` are ordinary columns with no verification gate on them at all
  (`trg_aa_landlord_verification_gate` only watches the verification-status columns). Any Ops
  staffer editing a landlord via `EditLandlordDialog.tsx`/`LandlordEditCard.tsx` — a plain
  `.update()`, no RPC — could silently change the payout number on an already-verified landlord
  with zero re-approval and zero effect on `verified`.
- Live counts at time of fix: **5,068** landlords verified; only **721** have ever had a resolved
  `landlord_verification_requests` row with a phone attached — the other **4,347** were verified
  through some other path with no phone-approval record at all. There was no data anywhere that
  actually represented "the number Ops approved."
- Two DB-level gates on the actual money-moving path were also checking the raw `phone` column,
  not anything tied to approval: `check_landlord_payout_eligibility()` (used by
  `issue-landlord-payout-otp`) and — more importantly — `enforce_landlord_payout_eligibility()`,
  the `BEFORE INSERT` trigger on `landlord_payouts` that is the actual last line of defense before
  any payout can be created. Neither ever compared the phone being paid to *any* approved value.

## What was fixed

**Migration `20260922150000_landlord_ops_approved_payout_number.sql`, applied live:**

- New columns on `landlords`: `verified_mobile_money_number`, `verified_mobile_money_set_at`,
  `verified_mobile_money_source`. Writable ONLY through `set_landlord_verification()` —
  `trg_aa_landlord_verification_gate` was extended to lock these three columns the same way it
  already locked `verification_status`/`verified`/etc (confirmed live: a direct `UPDATE` outside
  the RPC raises `42501 Landlord verification is locked`).
- `set_landlord_verification()`: on a transition to `verified`, snapshots the phone from the
  specific pending `landlord_verification_requests` row being resolved (the number Ops was
  actually looking at) into `verified_mobile_money_number`; falls back to whatever's currently on
  file only for ad-hoc verifications with no pending request (e.g. initial onboarding, several
  other UI entry points exist — `VerifyLandlordButton.tsx`, `ResidenceVerificationPanel.tsx`,
  `GlobalVerificationHub.tsx`, `RentPipelineQueue.tsx` — none of which currently prompt for a
  phone). On any transition AWAY from `verified` (rejected/pending/resubmitted), the snapshot is
  cleared to `NULL` — a revoked landlord can't be paid again until re-approved.
- **Backfill**: all 5,068 currently-verified landlords got `verified_mobile_money_number` set —
  from their matching resolved verification-request phone where one exists (a small minority),
  else from whatever's currently on file. This is a one-time grandfather of existing state, not a
  claim that Ops reviewed every one of those 4,347 numbers — verified live: 5,068/5,068 verified
  landlords now have a non-null approved number, 0 unverified landlords have one.
- `check_landlord_payout_eligibility()` and `enforce_landlord_payout_eligibility()` (the DB
  trigger) both now check `verified_mobile_money_number`, not raw `phone`. The trigger additionally
  now **rejects any `landlord_payouts` INSERT whose `landlord_phone` doesn't exactly match** the
  landlord's current `verified_mobile_money_number` — a structural guarantee independent of
  whatever the edge function does. Verified live against a real agent/landlord pair: eligible for
  a verified landlord with an approved number, `eligible: false` / `landlord_verified: false` for
  an unverified one.
- `issue-landlord-payout-otp`: now requires `verification_status = 'verified'` explicitly and
  reads `verified_mobile_money_number` (not `mobile_money_number`/`phone`) as the OTP-send target.
- Frontend (`AgentFloatPayoutWizard.tsx`, `AgentLandlordPayoutDialog.tsx`,
  `AgentManagedPropertiesSheet.tsx`): prefill/display and the block-if-missing check now all read
  `verified_mobile_money_number` exclusively. Copy changed from "no number on file" to "Landlord
  Ops has not approved a payout number for this landlord yet" throughout, including the picker
  list that shows each landlord's number before the agent selects one.
- `landlord-payout-disburse` needed no change — it already sources the phone from the verified
  `landlord_payout_otp_challenges` row (doc 111's fix), which now transitively carries the
  Ops-approved number since `issue-landlord-payout-otp` writes it there.

Verified live: `guard:all` passes, eslint on all four touched frontend files shows only
pre-existing `no-explicit-any` findings (nothing new).

## What not to do

- Don't fall back to `mobile_money_number`/`phone` anywhere in the payout path, even "just this
  once" for a landlord who's verified but has no approved number yet (e.g. one of the 4,347
  ad-hoc-verified landlords whose backfilled number turns out to be wrong) — that's the exact
  decoupling this fix closed. The correct fix is re-verification through
  `set_landlord_verification()`, which re-snapshots the number.
- Don't add a way to set `verified_mobile_money_number` directly (admin tool, migration, anything)
  outside `set_landlord_verification()` — the gate trigger exists specifically to make that
  impossible, matching the pattern this whole investigation kept finding: money-path code trusting
  a value nothing forced to stay correct.
- The other ~4,347 ad-hoc-verified landlords' backfilled numbers were never actually reviewed by
  Ops as "the approved payout number" — they're just what happened to be on file at migration
  time. If a wrong payout surfaces for one of them, don't treat it as a new bug in this fix; it's
  the known backfill limitation. The real fix for that landlord is re-verification.
