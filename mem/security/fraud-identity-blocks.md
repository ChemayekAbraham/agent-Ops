---
name: Fraud identity blocks
description: Fraud-cutoff accounts permanently block tied phone/email/mobile-money identifiers from signup, login, withdrawals, and earning credits
type: feature
---
Fraud-cutoff accounts must be permanently frozen and identity-blocked. Any phone,
email, mobile-money number, national ID, user id, or **display name (full_name)**
tied to a fraud account must not be allowed to sign up, sign in through
phone/email lookup, request withdrawals, receive payout approvals, or receive
future earning-style wallet credits.

`fraud_identity_blocks.identifier_type` supports `user_id | phone | email |
mobile_money_number | national_id | full_name`. `fraud_block_user_identifiers`
records all of them (full_name only when the normalized name is >= 5 chars, to
avoid over-broad single-word matches). `handle_new_user` rejects signup with
ERRCODE 28000 when any identifier — including the normalized full_name — is
blocked. This stops recycled accounts that reuse the same person's name with a
fresh phone/email (e.g. "Kayaga Catherine").

Phone is the strongest signal (a fraudster can rename but cannot change the
underlying number), so `fraud_block_user_identifiers` sweeps EVERY phone /
mobile-money number the account ever used — not just `profiles.phone` /
`profiles.mobile_money_number`, but also all `withdrawal_requests.mobile_money_number`
and `saved_payout_methods.momo_number` payout destinations — and blocks each as
both `phone` and `mobile_money_number` (normalized to the last 9 digits). Add
new payout-number sources to this sweep if more are introduced.

Use `fraud_identity_blocks` and the `is_fraud_identifier_blocked` /
`check_fraud_account_by_phone` / `check_fraud_account_by_email` /
`check_fraud_account_by_name` helpers. Name normalization = lowercase, strip
non-alphanumeric (keep spaces), collapse whitespace. Every fraud cutoff must
emit `system_events.event_type='account_flagged'` and an `audit_logs` row with
the reason.

Warning SMS language must be formal fraud/legal escalation wording, not fake
police impersonation.