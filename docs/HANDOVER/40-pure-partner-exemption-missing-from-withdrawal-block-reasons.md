# 40 — Pure-partner exemption missing from `payout_withdrawal_block_reasons`

**Read this before touching `payout_withdrawal_block_reasons`, `WithdrawFlow.tsx`'s
`identityBlock`/`showIdentityPanel` logic, or any of `enforce_withdrawal_destination_verified`,
`ensure_payout_destination`, `user_is_pure_partner`, `is_partner_not_agent`.**

## What was found

Investigating a report that a funder (Nankambo Sharimah — 5 `investor_portfolios`, zero
agent activity) "can't withdraw," and separately that she is supposed to be exempt from
ID/selfie submission but the app still demanded it.

There are (at least) **three independent places** that gate a withdrawal on identity/
destination verification, and they don't all agree on who's exempt:

1. `submit_withdrawal_request()` → calls `ensure_payout_destination()`, which auto-verifies
   a `waiting` destination for anyone `is_partner_not_agent()` returns true for.
2. `enforce_withdrawal_destination_verified()` (the `BEFORE INSERT` trigger on
   `withdrawal_requests`) → exempts anyone `user_is_pure_partner()` returns true for,
   checked *before* it even looks at destination status (so a pure partner bypasses a
   `rejected` destination too — that's pre-existing behavior, not something this fix
   changed).
3. **`payout_withdrawal_block_reasons()`** — the RPC that feeds `WithdrawFlow.tsx`'s
   `identityBlock` state (`useWithdrawalBlockReasons`). This one had **no exemption check
   at all**. It unconditionally returned `blocked: true, code: 'identity_not_submitted'`
   demanding a National ID photo + selfie whenever the caller had no active
   `user_identity_bindings` row — which a pure partner never has, because they've never
   needed one.

Since `WithdrawFlow.tsx` disables the Withdraw button and forces
`IdentityPhotoCapture` open whenever `identityBlock.data?.blocked` is true (see lines 141,
146-148, 768), this meant pure partners were shown a hard "submit your ID and selfie"
requirement the actual database gate never imposed on them. `is_partner_not_agent` and
`user_is_funder_with_portfolio` had already been correctly wired into the frontend's
`isPurePartner` / `funderExempt` flags — but `identityBlock` overrode them, because
`showIdentityPanel` is `identityBlock.data?.blocked || (!purePartnerLoading && !isPurePartner)`,
and `identityBlock.data?.blocked` was always `true` for a partner with no identity binding.

Verified against the three known partner-exemption users who already got auto-verified
under the 2026-09-15 `is_partner_not_agent` migration (`docs/HANDOVER` migration
`20260915140000_exempt_partner_not_agent_from_payout_destination_gate.sql`) — Simon Kavuma,
Elvis Opio, okee samuel, MARVIN SSEMBATYA — none of them have a `user_identity_bindings`
row either, so all four would hit this exact same false block.

## What was fixed

`20260916170000_exempt_pure_partner_from_withdrawal_block_reasons.sql` adds the identical
`user_is_pure_partner(v_uid)` check used by `enforce_withdrawal_destination_verified`,
short-circuiting to `blocked: false` **before** the rejected-destination check and before
the identity-binding check — same precedence the real DB-level trigger already uses, so
this advisory function now actually agrees with the gate that decides the outcome, instead
of contradicting it.

## What was deliberately left alone

- `is_partner_not_agent` (used by `ensure_payout_destination`) and `user_is_pure_partner`
  (used by the trigger and now this function) are two separately-defined functions with
  almost-identical but not-quite-identical logic (`is_partner_not_agent` also excludes
  `rent_requests.agent_id/assigned_agent_id/proxy_agent_id`; `user_is_pure_partner` only
  excludes `agent_collections`). Left as two functions rather than unifying them — that's
  a separate cleanup, not required to fix this specific bug, and unifying them without
  checking every caller first risks changing behavior for someone currently relying on the
  narrower one.
- The Sharimah account also has a same-day irregular fund reallocation (~UGX 27.5M moved
  in from two "Mercy Bayo"/"BAYO MERCY" accounts under a vague "NOT SUPPOSED HAVE" reason,
  and one of her saved payout numbers is literally Mercy Bayo's own phone number) — flagged
  to Josh separately, not touched here. That's a business/fraud-review question, not a
  code gate.

## Verify this is still fixed

```sql
-- Should return blocked=false for a pure partner, even with no identity binding.
select public.payout_withdrawal_block_reasons('59d45ad2-0d44-433c-b4ec-20927a25c281'::uuid);
```

## What not to do

- Don't add the identity-binding requirement back for pure partners "for consistency" —
  the whole point of the 2026-09-15 exemption was that partners don't need one; re-adding
  it here would just reopen this exact bug.
- Don't assume fixing this one function means every partner-facing surface agrees now —
  there could be a fourth place (a report, an admin panel) with the same kind of
  unconditional check. This pass only covers the Withdraw screen's block reasons.
