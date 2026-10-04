# 111 — Landlord payout phone number was agent-editable and client-trusted end to end

**Fixed 2026-09-22, committed to the repo; NOT YET DEPLOYED to production edge functions —
see "What still needs to happen" below.**

## What was reported

Josh: the boss was trying to withdraw Landlord Payout Float to pay a landlord and the phone number
didn't prefill. Instruction: close every place an agent can fill in that number.

## What was found

This was not just a missing-prefill UI bug. Investigating the whole agent-facing Landlord Payout
Float withdrawal flow (`AgentFloatPayoutWizard.tsx`, `AgentLandlordPayoutDialog.tsx`,
`issue-landlord-payout-otp`, `landlord-payout-disburse`) turned up a real money-misdirection path:

1. **Two agent-facing editable phone inputs**, not one:
   - `AgentFloatPayoutWizard.tsx` — a `phoneOverride` field, only locked when the landlord was
     `verification_status = 'verified'`. An unverified landlord (or, per the report, a landlord
     with no `mobile_money_number`/`phone` on file at all) left the field blank and freely
     editable — exactly what the boss hit.
   - `AgentLandlordPayoutDialog.tsx` — a second, independent `landlordPhone` input with **no
     verified-gate at all**, always editable regardless of landlord status.
2. **The backend trusted whichever phone string the client sent.** `issue-landlord-payout-otp`
   took `landlord_phone` from the request body with only a format regex check — no comparison to
   the `landlords` table — and used it to send the OTP.
3. **Worse: it silently persisted that client-supplied number back into `landlords.
   mobile_money_number`** (and `phone` if unset) before the OTP was even confirmed delivered,
   logged only as an `audit_logs` row with `action_type =
   'landlord_momo_number_corrected_by_agent'`. Any agent typing a number they controlled into
   either form would permanently retarget that landlord's stored payout number for every future
   payout too, not just the one in progress.
4. **`landlord-payout-disburse` never checked the phone against the OTP that was actually
   verified.** It re-verifies that a `landlord_payout_otp_challenges` row exists and is
   `status = 'verified'` and fresh (≤120s) — good — but then used the request body's
   `landlord_phone`/`landlord_name` (a *separate* call, with its own body) for the actual
   `landlord_payouts.landlord_phone` and, critically, `withdrawal_requests.mobile_money_number` —
   the field Financial Ops actually sends MoMo to. Nothing tied the verified OTP to the phone
   money was sent to; an agent (or any caller with a valid session) could OTP-verify number A and
   disburse to number B in one extra step.

## What was fixed

- **`AgentFloatPayoutWizard.tsx`** — removed `phoneOverride` entirely. The landlord MoMo number is
  now always read-only, always the number on file (`mobile_money_number || phone`), for every
  landlord regardless of verification status. If no number is on file, "Send OTP" is blocked with
  an explicit error instead of leaving an empty editable box. The existing "Request change from
  Landlord Ops" affordance (writes to `landlord_verification_requests`, human-reviewed) is now the
  *only* way to change a landlord's number, unconditionally — not just for verified landlords.
- **`AgentLandlordPayoutDialog.tsx`** — same treatment: `landlordPhone` is now a derived, read-only
  value from `property.mobile_money_number ?? property.phone`, never a typed `useState`. "Send OTP
  to Landlord" is disabled when there's no number on file.
- **`supabase/functions/issue-landlord-payout-otp/index.ts`** — the primary OTP-send path no
  longer reads `landlord_phone` from the client at all. It looks up `landlords.
  mobile_money_number`/`phone` server-side by `landlord_id`, rejects with a clear error if neither
  is set, and uses that resolved number for the SMS send and the `landlord_payout_otp_challenges`
  row. The entire silent-overwrite-into-`landlords` block is deleted — it can never fire again
  because the server never has a "different" client-supplied number to compare against. (The
  resend path was already safe — it re-uses `existing.landlord_phone` from the challenge row, not
  client input — untouched.)
- **`supabase/functions/landlord-payout-disburse/index.ts`** — no longer trusts
  `landlord_phone`/`landlord_name` from the request body at all. The verified-challenge lookup now
  selects `landlord_phone, landlord_name` from the same `landlord_payout_otp_challenges` row whose
  `verified_at` freshness it already checks, and every downstream write (`landlord_payouts`,
  `withdrawal_requests.mobile_money_number`/`mobile_money_name`, the FinOps queue reason string,
  the agent notification) uses that verified value. Money can now only go to the exact number the
  landlord actually OTP-verified — no separate body field to disagree with it.
- `verify-landlord-payout-otp/index.ts` (the function `AgentLandlordPayoutDialog.tsx` calls
  directly) was already deriving phone from the challenge row (`ch.landlord_phone`), not the
  client — it inherits the fix automatically now that `issue-landlord-payout-otp` always writes
  the DB-derived number into that row. No changes needed there.

Verified: `npm run guard:all` passes (frontend ledger-write guard included — unaffected, no direct
writes added), `eslint` on both touched components shows only pre-existing `no-explicit-any`
findings, no new errors.

## What still needs to happen

**The two edge function fixes are committed to the repo but NOT live yet.** This repo's edge
function deploy pipeline (`.github/workflows/deploy-edge-function.yml`) is deliberately
manual-only, one function per run, from a fixed choice list — added `issue-landlord-payout-otp`
and `landlord-payout-disburse` to that list in this same change, but nobody has triggered the
workflow. **Until a maintainer runs it, production is still running the old, phone-trusting
code** — only the frontend fix (which stops the UI from offering an editable field) is live once
this deploys through the normal frontend build/publish path. Deploy `issue-landlord-payout-otp`
first (it's the source of the phone `landlord-payout-disburse` now trusts), verify, then deploy
`landlord-payout-disburse`.

## What not to do

- Don't re-add a client-supplied `landlord_phone` field to either edge function's trusted logic,
  even for a "just this once, the number on file is wrong" fix — that's exactly the hole this
  closed. The only sanctioned path to change a landlord's number is
  `landlord_verification_requests`, reviewed by a human at Landlord Ops.
- Don't assume the frontend lock alone closes this — both edge functions were directly callable
  (and, per the disburse-side gap, callable with a *different* phone than what was OTP-verified)
  regardless of what the UI allowed. The backend re-derivation is the actual fix; the UI lock is
  just removing the obvious way to trip it.
