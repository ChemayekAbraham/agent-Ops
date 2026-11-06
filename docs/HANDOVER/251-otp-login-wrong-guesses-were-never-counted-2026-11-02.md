# 251. otp-login never counted wrong guesses (2026-11-02)

**Status:** function APPLIED TO PRODUCTION by hand 2026-11-02 (inert, locked to `service_role`); migration file and edge-function change WRITTEN, NOT COMMITTED, NOT DEPLOYED.

## Problem
`otp-login` looked the code up with `phone AND otp_code = guess`. A wrong guess found no row, so it returned 400 without touching `otp_verifications.attempts`. The `attempts >= 5` check only ran for a guess that was already correct, so the limit never stopped guessing. The increment was also read-modify-write in JavaScript, which parallel requests can all read at the same old value.

## Change
- `public.register_otp_attempt(p_otp_id uuid)` (migration `20261102090000`): one `UPDATE ... SET attempts = attempts + 1 ... RETURNING attempts`. `SECURITY DEFINER`, `search_path = public`, execute revoked from `public/anon/authenticated`, granted to `service_role` only. Verified live: `otp_verifications.id` is `uuid`; `anon/authenticated/service_role` privilege = false/false/true; `attempts` is `NOT NULL DEFAULT 0` with no null rows.
- `supabase/functions/otp-login/index.ts`: the row is found by phone only (newest live, unverified code), one attempt is burned through the RPC, more than 5 returns 429, and only then is the guess compared. If the RPC fails the login is refused (fail closed).

## Behaviour changes
- "Code expired" and "Invalid code" for a missing live code merge into "Code expired or not found."
- Only the newest live code for a phone is checked (before, any matching live code worked).
- 5 guesses allowed per code; the 6th gets 429.

## Not done
- Per-phone and per-IP lockout across codes (an attacker can still request fresh codes). `sms-otp` and `password-reset-sms` have not been checked for the same flaw.
- Deploy order: the function already exists in production, so deploying `otp-login` is safe at any time. Roll back by redeploying the previous `otp-login` (the function can stay).
