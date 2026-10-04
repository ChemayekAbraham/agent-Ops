---
name: Depositor profile self-heal
description: Auto-creates/links a verified searchable profile whenever a credited deposit exists but the depositor has no findable profile (Partnership Ops visibility)
type: feature
---
# Depositor profile self-heal

Guarantees every credited depositor is findable + verified for Partnership Ops (who search `profiles` by name/phone to invest/top up from a user's wallet).

- **`ensure_depositor_profile(p_user_id)`** (SECURITY DEFINER): if the user already has a profile → marks it verified. Else derives name/phone from `auth.users` (phone from `phone`/meta, or parsed from a `NNN@welile.user` email prefix), then:
  - If the phone is held by an **empty duplicate shell** (no `wallet_deposit` ledger, no `rent_requests`, no `deposit_requests`, zero withdrawable) → migrates its `user_roles` to the credited account, deletes the shell profile+roles, then creates the verified profile.
  - If the phone is held by an **active** duplicate → logs `manual_review` (never auto-merges active accounts).
  - No `auth.users` row (operational/platform ledger accounts) → returns `no_auth_user`, skipped.
- **Trigger** `trg_ensure_depositor_profile_on_credit` AFTER INSERT on `general_ledger` for `category='wallet_deposit' AND direction='cash_in'`; wrapped in EXCEPTION → NEVER blocks a deposit.
- **`reconcile_credited_deposit_profiles()`** + nightly cron `reconcile-credited-deposit-profiles` (01:15) backfills credited depositors with no own profile.
- All actions logged to **`deposit_profile_reconciliations`** (action: created / retired_shell_and_created / manual_review / no_phone / error); manager-only SELECT.

Origin: Ssembatya Marvin had a credited UGX 500k on one UUID (no profile) while an empty duplicate UUID squatted his phone — invisible to Partnership Ops.
