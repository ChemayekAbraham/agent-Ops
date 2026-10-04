# 122 — Verified landlord's payout blocked because the approved number had spaces in it

**Fixed live 2026-09-24 (migration `20260924153000_landlord_payout_phone_match_normalized.sql`).
The `issue-landlord-payout-otp` tweak is committed but NOT yet deployed, and it isn't needed for
the fix.**

## What was reported

Screenshot from an agent, 2026-09-23 18:34 EAT: "Pay Emilio Odongo", UGX 5,000,000 to 0772363578.
The UI said "Matches the number approved by Landlord Ops — locked" and "Verification Complete", but
the payout never went through. "Retry Payout" didn't help.

## What was found

- Challenge `7669a88a-75fc-45ea-a71d-36108837bc32`: the OTP was verified at 15:34:25 UTC.
  `landlord-payout-disburse` then failed one second later with *"Payout phone does not match the
  number Landlord Ops approved for this landlord."*
- `landlords.verified_mobile_money_number` = **`0772 363 578`**, with spaces
  (`migration_backfill_20260922`, doc 112). The on-file number and the challenge both hold
  `0772363578`.
- `enforce_landlord_payout_eligibility()` (doc 112) compared these with `IS DISTINCT FROM`, an exact
  string match. It's the same subscriber, but the strings differ, so the payout was refused *after*
  the landlord had already given the OTP. The UI and edge function both compare normalized numbers,
  so everything upstream said "match".
- **Exposure:** 597 verified landlords have an approved number that differs from the on-file number
  only in formatting. Each of them would fail the same way on their first payout. Only Emilio's
  payout had actually hit it (UGX 5,000,000 stuck); an earlier 09-17 attempt failed on the same
  landlord under the older check.

## What was fixed

- `enforce_landlord_payout_eligibility()` now compares `landlord_number_norm()` (last 9 digits, the
  same normalization the doc 120 lock uses). Verified live with a rolled-back probe on Emilio's
  payout: `0772363578` → inserted OK; `0709111222` → still refused "does not match".
- The function was added to `critical_function_baselines` in the same migration.
- `issue-landlord-payout-otp` strips spaces and dashes from the approved number before storing it on
  the challenge. That value flows into `withdrawal_requests.mobile_money_number`, which FinOps pays.
  This only matters once doc 120's edge change is deployed.

## For the agent

Yesterday's OTP can't be reused. `landlord-payout-disburse` only accepts an OTP verified within the
last 2 minutes, so "Retry Payout" on that old screen will say "re-verify". The agent should close the
dialog and start **Pay Landlord** again. Emilio gets a new OTP, and the payout now goes through.

## What not to do

- Don't "fix" this by rewriting `verified_mobile_money_number` formatting in bulk. The column is
  locked to `set_landlord_verification()` and the chain on purpose, and the normalized compare makes
  the formatting irrelevant anyway.
- Don't go back to an exact string compare. Normalizing to the subscriber number is not a
  loosening: a different number still fails.
