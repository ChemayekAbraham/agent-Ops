# 211 — Merchant claim requires a verified payout number (Carol Atuhaire 700k, 2026-10-08)

**Status: BUILT 2026-10-08, migration `20261008160000_merchant_claim_requires_verified_payout_number.sql` NOT applied.** Verify live after applying (see [06-live-state-verification.md](./06-live-state-verification.md)).

## Incident

Withdrawal `de2f2986-4853-4d5b-a7a4-44d9be8e74b2` (ATUHAIRE CAROLYNE, 700,000, requested 2026-10-07 15:49 UTC, completed 2026-10-08 08:39 UTC):

- OTP challenge was for her own number **0753039738** (her login phone, her only *verified* destination) and she confirmed it in 31 s.
- The withdrawal row carries **0754338755** (Airtel). That is the registered phone of a different profile, NAKAYIMA VERONICA (partner import 03-18; Carol's proxy portfolio was re-pointed to her in June/July). On Carol's destinations it is a never-verified `waiting` row.
- `submit_withdrawal_request` replaced the client's number with `resolve_withdrawal_destination()`, which, with no identity-binding row, falls back to `profiles.mobile_money_number` (= 0754338755). Audit: `WITHDRAWAL_DESTINATION_OVERRIDE_ATTEMPT`, attempted …9738, locked …8755.
- `enforce_withdrawal_destination_verified` exempts pure partners (`user_is_pure_partner`), and the claim RPC only compared the claimed number to the *stored* number. So nothing checked the number against verified destinations; a merchant paid 0754338755. The release was recorded with reason "ID mismatch".

Open: who wrote `profiles.mobile_money_number = 0754338755` (no audit row; `updated_at` 2026-10-08 12:46 after the payout). Whether Carol knows Nakayima, and recovery of the 700k, are Ops calls.

## Change

`claim_withdrawal_verified` gets step **C2**, before the one-active-claim check, priority holds and any float reservation. It calls the new `withdrawal_payout_number_check(withdrawal_id)` (jsonb: `applies`, `trusted`, `reason`, `matched_via`). The stored number must match, on the last 9 digits, one of:

1. a `payout_destination_verifications` row for the withdrawing user with `status = 'verified'`;
2. the user's non-revoked `user_identity_bindings.locked_payout_number`;
3. the user's own `profiles.phone` (OTP-proven at sign-in).

Otherwise the claim fails with `CLAIM_DETAILS_MISMATCH` / `payout_number_not_verified`, logged to `merchant_claim_log` with the check JSON (including whether the number belongs to another user). Pure-partner status and ID exceptions do **not** bypass it.

Out of scope on purpose (the check returns `applies: false`): landlord payouts (own OTP/lock chain), proxy payouts initiated by another user (the route decides the destination), bank transfers, cash. Already-claimed rows are untouched.

## Measured impact (last 30 days, mobile money)

Direct wallet withdrawals (not landlord, not proxy) that would have failed the check: 18 partner rows (6.8M) and 155 non-partner rows (9.5M). Today's open 700k (`885db5b1…`, Kalyango Timothy) passes via verified destination and lock; Carol's would be blocked. Expect FinOps to see claim failures for unverified numbers; the fix is to verify the destination (or have the customer re-submit with a verified number), after which the row is claimable.

## Not done / follow-ups

- `submit_withdrawal_request` still falls back to unverified `profiles.mobile_money_number`, and the OTP is sent to the account phone rather than the destination. Root fix pending Josh's call.
- `auto_dispatch_withdrawals` assigns without this check. No cron currently references it; add the predicate if it is ever scheduled.
- UI: the merchant queue could hide or badge rows where `withdrawal_payout_number_check(...)->>'trusted'` is false (Gemini's lane).
