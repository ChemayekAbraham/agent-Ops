---
name: Referral Signup Bonus
description: UGX 100 credited to referrer's withdrawable wallet once the invited person completes their persona milestone (not on sign-up alone)
type: feature
---
Current live behaviour (verified 2026-10-17 against prod functions):

1. Someone signs up via a shared referral link -> `handle_new_user` writes `profiles.referrer_id`.
2. `ensure_referral_record_on_profile` (AFTER INSERT OR UPDATE OF referrer_id ON profiles) inserts a `referrals` row with `bonus_amount = 100, restricted_amount = 100`. Guards: no self-referral, referrer not frozen, `ON CONFLICT (referrer_id, referred_id) DO NOTHING`, exception-wrapped so it never blocks sign-up. (This trigger closed the 2026-09 gap where link sign-ups created no referral record.)
3. `try_credit_qualified_referrals` pays ONLY when `get_referral_progress(referred).qualified = true` — the invited person must complete a milestone by persona:
   - agent: >=1 verified house listing AND >=1 rent request funded/repaying/completed
   - tenant: >=1 rent request funded/repaying/completed
   - funder (supporter): >=1 active/completed/repaying/matured portfolio
   - landlord: a verified landlord record matching their phone (self-verified)
   - general: any of the above
4. Payment posts a balanced double-entry via `create_ledger_transaction` under idempotency key `referral_signup:<referral_id>`: platform `marketing_expense` cash_out / wallet `referral_bonus` cash_in, `ledger_scope:wallet`, `recipient_type:user` -> referrer's withdrawable wallet. Amount is `COALESCE(restricted_amount, 100)`. Then `credited/unlocked = true`, audit log `referral_bonus_unlocked`, notification "Referral bonus unlocked".

CRITICAL: `create_ledger_transaction` takes `(entries jsonb, idempotency_key text)` — no `p_description` param; `transaction_group_id` is uuid. Historical `bonus_amount` values of 300 and 500 exist in the referrals table from older rules; the live trigger now writes 100. Do not describe the bonus as auto-paid on sign-up — milestones gate it.
