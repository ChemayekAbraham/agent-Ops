# 80 — `issue-wallet-withdrawal-otp` was a third real gate never wired to `id_verification_exceptions`

**Fixed in code 2026-09-18, not yet deployed. Read this before touching
`issue-wallet-withdrawal-otp`, `verify-wallet-withdrawal-otp`, or any withdrawal identity gate
again — check this doc's list of now-fixed gates before assuming a new one is covered.**

## What was reported

Josh, screenshot of Nabbaale Claire's phone at the final Confirm-Withdrawal step: "ALL THE USERS
EXEMPTED BY THE CTO ARE FACING THAT" — "⚠ Cannot send code — Submit your National ID details and
payout phone number first, then you can withdraw. No verification code was sent."

## What was found

Doc 75 fixed the two gates that actually decide whether a `withdrawal_requests` row gets created
(`submit_withdrawal_request`, `enforce_withdrawal_destination_verified`). Doc 76 fixed the dialog's
own client-side re-derivation. Neither one touches `issue-wallet-withdrawal-otp` — a **third**,
completely independent server-side gate: the edge function that sends the SMS code the Confirm step
is waiting on. It calls `ensure_payout_destination` itself, then (for a non-verified, non-rejected
destination) checks for a `user_identity_bindings` row with photos and a matching locked number —
and refuses with `identity_not_submitted` ("Submit your National ID details and payout phone number
first...") if none exists. It never checked `id_verification_exceptions` at all. An exempted user
with no ID/photos on file (the entire point of the exception) sails through every gate doc 75/76
fixed, then hits this one at the very last step, no SMS ever sent.

This is the third real, independent gate found today with its own copy of "is this user identity-
verified" logic that had to be patched by hand (submit_withdrawal_request/trigger in doc 75, this
edge function now). Doc 75's closing note already predicted this: "if a new withdrawal path... turns
up that checks destination/identity status without also checking `id_verification_exceptions`, it
will silently reject an exempted user again."

## What was fixed

`supabase/functions/issue-wallet-withdrawal-otp/index.ts` — added an `id_verification_exceptions`
lookup (`idExempt`) right after the `ensure_payout_destination` call, and added `&& !idExempt` to
the gate condition (`if (destStatus !== "verified" && !identityPendingOk && !idExempt)`). Same
precedence as docs 75/76: bypasses both the `destination_rejected` and `identity_not_submitted`
branches together, since an exception means skip ID verification entirely, not skip one leg of it.

**Deploy status unknown / likely blocked.** Doc 79 (same day) found the manual
`.github/workflows/deploy-edge-function.yml` path completely non-functional —
`weliletenants-sys/welilereceipts-com-98bba33b` has zero GitHub Actions secrets configured, so
`SUPABASE_ACCESS_TOKEN` doesn't exist and the workflow has never once succeeded. Doc 60 separately
found production edge functions can run an older build than the repo even after a push/merge. This
fix is committed to the repo but there is no confirmed working path from here to production for an
edge function — unlike the database function fixes today (72/74/75), which had a working manual
path via Lovable Cloud → SQL editor. Whether Lovable's own build pipeline redeploys edge functions
automatically on a push to `origin/lovable` (separate from the broken GitHub Actions workflow) is
unconfirmed — verify live before telling anyone this is fixed.

## Gates now covered by `id_verification_exceptions` (as of this doc)

1. `payout_withdrawal_block_reasons` — advisory, feeds the Withdraw screen's message (doc 72, 74).
2. `submit_withdrawal_request` — the RPC that actually inserts `withdrawal_requests` (doc 75).
3. `enforce_withdrawal_destination_verified` — the `BEFORE INSERT` trigger, true DB-level backstop
   for any insert path (doc 75).
4. `WithdrawFlow.tsx`'s own client-side field checks (doc 76).
5. `CTOKycLevelPanel.tsx`'s Grant-button visibility (doc 77 — not a money gate, but the control that
   creates the exception in the first place was itself broken).
6. `issue-wallet-withdrawal-otp` — this doc.

Still only confirmed by inspection, not exhaustively grepped: `withdrawal_user_id_verified` (the
merchant-claim gate) already had it from the start (`20260914240000`) and needed no change.

## What not to do

- Don't treat this list as closed. Every one of docs 72/74/75/76/77/80 was found by testing an
  actual exempted account through a real flow, not by code review alone — grep every
  `payout_destination_verifications`/`user_identity_bindings` read across `supabase/functions/` and
  `src/` before telling anyone an exception is "fully wired now."
- Don't skip the `!idExempt` short-circuit specifically for the `destination_rejected` branch
  "since Financial Ops already made a decision" — the exception's own design intent
  (`20260914240000`'s comment) is that it bypasses both branches together, and that's the precedent
  every other gate fixed today already follows.
