# 76 — `WithdrawFlow.tsx` kept the identity/destination steps locked even after doc 75's server fix

**Fixed in code 2026-09-18, not yet deployed (frontend). Read this before touching
`needsNationalId`, `needsIdentityPhotos`, `showIdentityPanel`, `identityHardBlock`, or
`destinationGateExempt` in `WithdrawFlow.tsx` again.**

## What was reported

Josh, after granting an ID-verification exception in the CTO panel: "the withdrawal dialog should
be free once he is ID exempted."

## What was found

Doc 75 made an active `id_verification_exceptions` row bypass every *server-side* gate
(`payout_withdrawal_block_reasons`, `submit_withdrawal_request`, the `enforce_withdrawal_
destination_verified` trigger). But `WithdrawFlow.tsx` — the actual dialog — computes its own,
independent "does this step need to be shown / does Next stay disabled" flags from raw client-side
field checks, and none of them had ever heard of the exceptions table:

- `needsNationalId` had **no exemption check at all** — it was purely `!national_id`. A CTO-exempt
  user with no National ID on file (the entire point of the exception) still hit this hard stop.
- `needsIdentityPhotos` only checked the client-side `useIsPurePartner` hook (mirroring
  `user_is_pure_partner`) — the same narrower, wrong-in-some-cases check doc 74 already replaced
  server-side.
- `showIdentityPanel` — same `isPurePartner`-only check.
- `destinationGateExempt` only checked `payoutMode === 'cash'` or `useIsFunderWithPortfolio`
  (mirroring `user_is_funder_with_portfolio`, the function found in doc's Lukodda-Joseph
  investigation to already differ from what the identity gate actually needs).

`identityHardBlock` ORs `needsNationalId || needsIdentityPhotos || identityBlock.data?.blocked`
together to decide whether to cover the whole withdraw section with an overlay and remove the
stepper nav — so even with `identityBlock.data?.blocked === false` (server: fully clear), an
exempted user with no ID/photos on file still got the full block screen, because the other two
terms didn't know they were exempt. Confirmed on Lukodda Joseph's screenshot: "Oops! Your
withdrawal details are not complete yet" plus a "Submit your National ID first" hard stop, despite
(once exempted) the server side already being clear.

## What was fixed

`src/components/payments/WithdrawFlow.tsx` — added one derived value,
`identityFullyClear = identityBlock.data?.blocked === false`, treating the same RPC already fetched
for the advisory banner as the authoritative "nothing left to ask" signal (it already covers every
exemption source doc 72/74/75 wired in — partner-not-agent AND the exceptions table — so this
doesn't need its own separate exceptions query). Gated the client-side re-derivations with it:

- `needsNationalId`: `&& !identityFullyClear`
- `needsIdentityPhotos`: `&& !identityFullyClear`
- `showIdentityPanel`: `!identityFullyClear && (...)`
- `destinationGateExempt`: `|| identityFullyClear`

`identityHardBlock` and `canProceed()` needed no direct change — once the three flags above are
correctly false/true, they already resolve correctly, since `identityBlock.data?.blocked` is also
`false` in the same state.

Not yet deployed (frontend-only change, same as docs 59/65/67/68).

## What not to do

- Don't add a fourth, separate "is this user exception-exempt" client hook — `identityBlock`
  (`payout_withdrawal_block_reasons`) is already the single source of truth for the whole identity/
  destination gate as of docs 72/74/75; querying `id_verification_exceptions` or
  `is_partner_not_agent` directly from the client again would just reintroduce the same
  client/server drift this doc fixes.
- Don't assume a server-side exemption fix (docs 72/74/75) automatically reaches every UI surface
  that independently re-derives "am I blocked" from raw profile fields — this is the second time
  today an exemption source needed to be threaded through multiple layers by hand (doc 75 was the
  first, for the DB-level gates). Grep `needsNationalId`/`needsIdentityPhotos`/`isPurePartner`/
  `funderExempt`-shaped patterns in any other withdrawal-adjacent screen before assuming they agree.
