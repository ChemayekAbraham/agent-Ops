# 136 — Payout destinations auto-verify without waiting on a Financial Ops call

**Date:** 2026-09-25 · **Asked by:** Josh ("waiting on Financial Ops phone verification should be automatic")
**Migration:** `supabase/migrations/20260925170000_auto_verify_waiting_payout_destinations.sql`
**Frontend (hook only):** `src/hooks/usePayoutVerification.ts`, where `useMyPayoutDestinations` calls `recheck_my_payout_destinations()` before it reads the list.

## Problem

On 2026-09-25 there were 2,819 rows in `payout_destination_verifications` with status `waiting`. None had been auto-verified since 2026-09-24 13:40 UTC.

The auto-verify rule `auto_verify_matching_payout_destinations` verifies a destination when:
- the name on the National ID matches the account name (score ≥ 0.9),
- the ID photo and selfie are on file,
- and the account is not a double submission.

That rule's **only** caller is `submit_identity_photos`. `ensure_payout_destination` inserts every new number as `waiting` and never re-checks it. So a person who captured their ID first and then withdrew to a number in their own name still went into the Financial Ops call queue.

## Fix

- **`payout_destination_auto_verdict(user_id, account_name, national_id)`** holds the single rule. It returns null (no auto-verify) for:
  - no ID photo or selfie,
  - a double submission,
  - a National ID that already belongs to another account,
  - an ID name shorter than 5 characters,
  - a name-match score below 0.9.
- **`trg_zz_auto_verify_payout_destination`** is a BEFORE INSERT/UPDATE trigger that sets the row to `verified`. Because it runs before the write, `ensure_payout_destination`'s RETURNING already says `verified`, and the withdrawal OTP goes ahead on the same attempt.
  - It writes an `audit_logs` row (`payout_destination_auto_verified`) and sets `profiles.full_name` to the ID name, as the existing rules do.
  - The name `zz` makes it sort after `trg_auto_reject_duplicate_national_id`.
  - Any error is caught and the row stays `waiting`, so it can never break the withdrawal OTP.
- **`auto_verify_waiting_payout_destinations(user_id default null)`** is the sweep. It only touches rows that will pass.
  - **`trg_recheck_payout_destinations_on_id`** runs it when a profile's `national_id_name`, ID photo, selfie or `national_id` changes.
  - Cron `auto-verify-waiting-payout-destinations` runs it every 10 minutes.
  - It runs once at the end of the migration as a backfill.
- **`recheck_my_payout_destinations()`** is callable by `authenticated` and only checks the caller's own rows. The withdraw screen's "Check again" button reaches it through the hook's refetch.
- `ensure_payout_destination` is untouched. It is in `critical_function_baselines`, so no re-baseline is needed.

## Deliberately left with Financial Ops

- **Names that don't match the ID** (relatives, partners). The owner can still clear these instantly with the existing SMS consent code.
- **Destinations a human rejected**, including the "Resubmitted after rejection" state.
- **About 2,500 waiting rows whose owners never uploaded an ID photo and selfie.** There is no evidence to verify them on. This is most of the queue, so the first backfill only cleared **4 rows** (12 with the update below). The gain is that matching numbers no longer queue from now on.
## Update, same day: the SMS code + face + ID number rule is now wired in too

Migration `20260925180000_wire_sms_face_nin_payout_auto_verify.sql` makes `payout_auto_verify_ready` a second rule inside `payout_destination_auto_verdict`. Josh asked for this. The rule verifies a destination when:
- the number is proven to be theirs,
- the latest `national_id_readings` row has `face_verified`,
- and the ID number read off the photo equals the typed one.

A new trigger, `trg_recheck_payout_destinations_on_reading`, re-runs the check whenever a reading lands. The migration is self-contained: it recreates everything from `20260925170000`.

An earlier draft of this doc said "do not wire it in", because the account name differs from the ID name on all 8 rows it clears (e.g. "Yaseen Sebunya" on Shafeeq Ssenabulya's ID). That was overstated, and those 8 rows are legitimate:
- all 8 confirmed that exact destination with the SMS code;
- 7 of the 8 are the person's own login phone and registered payout number;
- no other account uses any of the 8 numbers.

This is the normal case of a MoMo line registered in a relative's name.

**Gap closed while wiring:** `payout_number_ownership_confirmed` also accepts *any* verified `otp_verifications` row for the number, and that table has no `user_id`. So the number's real owner signing up would count as ownership for someone else. The auto-verify path accepts only two things:
- `ownership_code_confirmed_at` on the destination row, or
- the number being the person's own `profiles.phone`.

`payout_auto_verify_ready` itself is unchanged and still has no callers. The backfill now clears **12** rows (4 by name match, 8 by this rule).

## Risk note

The account name is typed by the user, not looked up from the network. This change applies the existing name-match rule every time, not only at photo upload. It is contained by `enforce_withdrawal_payout_account_lock`: a wallet withdrawal can only go to `profiles.mobile_money_number`, and moving that number goes through the Financial Ops number-change queue.

## Verify after deploy

```sql
select tgname from pg_trigger where tgname in ('trg_zz_auto_verify_payout_destination','trg_recheck_payout_destinations_on_id','trg_recheck_payout_destinations_on_reading');
select jobname, schedule from cron.job where jobname = 'auto-verify-waiting-payout-destinations';
select count(*) from audit_logs where action_type = 'payout_destination_auto_verified' and created_at > '2026-09-25';
```
