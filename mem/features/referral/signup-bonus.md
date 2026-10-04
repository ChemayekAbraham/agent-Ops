---
name: Referral Signup Bonus
description: UGX 500 auto-credited to referrer wallet when someone signs up via their shared link
type: feature
---
When a new user signs up via a shared referral link (`referrer_id` in auth metadata):
1. `handle_new_user` writes `profiles.referrer_id`.
2. `trg_credit_referral_bonus` (AFTER INSERT on profiles) inserts a `referrals` row with `bonus_amount = 500`, `credited = false`.
3. `trg_credit_signup_referral_bonus` (AFTER INSERT on referrals) posts a balanced ledger txn via `create_ledger_transaction(entries, idempotency_key)`:
   - platform leg: `marketing_expense` / cash_out
   - wallet leg: `referral_bonus` / cash_in / `ledger_scope:wallet` / `recipient_type:user` -> lands in referrer's withdrawable wallet.
   Idempotency key: `referral_signup:<referral_id>`. Marks `referrals.credited = true`.

CRITICAL: `create_ledger_transaction` takes `(entries jsonb, idempotency_key text)` - there is NO `p_description` param and `transaction_group_id` is uuid. The old trigger used a bogus signature (text group id + p_description) and failed silently from Apr-Jun 2026, leaving ~698 referrals uncredited. Fixed 2026-06-17.
