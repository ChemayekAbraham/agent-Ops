# 260. Withdrawal PIN: email-change hold (2026-11-05)

**Status:** WRITTEN FOR REVIEW. Migration, rollback and manual test are in the repo on `dev/withdrawal-pin`. **Not applied anywhere, not run.**
**Closes:** doc 258 decision 2 / doc 259 section 8 open item 5 (the account-takeover path through the email).
**Files:** `supabase/migrations/20261105090000_withdrawal_pin_email_change_hold.sql` (+ `.rollback.sql`), `supabase/tests/withdrawal_pin_email_hold_tests.sql`.

## 1. The hole

Forgotten-PIN reset needs only a code emailed to the address on file (doc 259). Changing that address (`email-verify-request` then `email-verify-confirm`, which calls `confirm_email_verification`) proves only that the NEW address belongs to the caller. A person holding a logged-in session can therefore point the email at their own inbox, reset the PIN, and withdraw (the withdrawal OTP still goes to the typed payout number, doc 258 section 8).

## 2. The fix

* New config `withdrawal_pin_config.email_change_hold_hours` (default 48, range 0 to 168; 0 switches it off).
* New column `user_withdrawal_pins.email_changed_at`.
* An `AFTER UPDATE OF email` trigger on `profiles` (SECURITY DEFINER, internal, service role only). When the address really changes (case-insensitive) **and the user has a PIN**, it stamps `email_changed_at`, **cancels any pending reset**, and writes the audit row `WITHDRAWAL_PIN_EMAIL_CHANGED`. Users without a PIN are untouched.
* `pin_reset_begin` (same body as before plus one check) answers `{success:false, code:'email_recently_changed', release_at}` inside the hold. `pin_challenge_issue` already requires a pending reset, so no code can be sent for a cancelled one.

Why a trigger and not an edit of the email functions: the live `confirm_email_verification` is not faithfully in the repo (CLAUDE.md), and a trigger covers every writer of `profiles.email` (self-service, staff, import) with one rule.

## 3. Side effects the CTO should accept or reject

* A PIN holder who legitimately adds or changes their email cannot reset a forgotten PIN for 48 h. They can still use the PIN, and Support can help.
* A user who moves from a placeholder address to a real one is held the same way (only if they already have a PIN).
* Staff or import edits of `profiles.email` for a PIN holder also start the hold.
* The hold does **not** stop an attacker from withdrawing with a PIN they already know, and it does not notify the old address. Telling the old address "your email was changed" is a sensible next step (not built).

## 4. Not covered

* A change made directly on `auth.users` without touching `profiles.email` (no code path does it today; the edge function reads the sign-in address first).
* Changing the PIN with the current PIN and an emailed code is unaffected by the hold (it needs the PIN, a factor the attacker lacks).

## 5. To do before applying

1. Android: add a message for `email_recently_changed` (show `release_at`). The edge function already passes the code through with a 400.
2. Run `withdrawal_pin_email_hold_tests.sql` inside its rollback on the CTO's own account.
3. Apply with the existing 5 s `lock_timeout`; it takes a short lock on `profiles` (adds a trigger) and `user_withdrawal_pins`/`withdrawal_pin_config` (adds columns). Verify the trigger exists afterwards (migrations diverge from production).

## 6. Rollback

`update public.withdrawal_pin_config set email_change_hold_hours = 0` (non-destructive), or `20261105090000_withdrawal_pin_email_change_hold.rollback.sql` and re-run `pin_reset_begin` from `20261104150100`.
