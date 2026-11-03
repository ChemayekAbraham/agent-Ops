# 256. password-reset-sms: reset-code guessing was effectively unlimited, and a used code could be reused (2026-11-03)

**Status:** WRITTEN AND TESTED LOCALLY, COMMITTED ON `dev/otp-attempt-limits`, NOT PUSHED, NOT DEPLOYED. Depends on database functions that must exist in production first (see Deploy order).

## Problem
`verify-and-reset` sets a new password on EVERY account tied to a phone number once the 6-digit reset code matches. Whoever knows a phone number could try to guess that code, because:
- the wrong-guess counter was read-then-write in JavaScript (`attempts + 1`), so parallel guesses undercount (the same flaw as docs 251/255);
- the send limit was an in-memory `Map`, which resets on every cold start and is not shared between function instances;
- every `send` wrote `attempts: 0` while reusing the same still-valid code, so "send, guess 5, send, guess 5" had no ceiling;
- `verify-and-reset` never checked `verified`, so a code that had already reset a password worked again for the rest of its hour.

## Change (`supabase/functions/password-reset-sms/index.ts`)
- `verify` and `verify-and-reset` burn an attempt through `register_otp_attempt` (doc 251) BEFORE comparing; more than 5 returns 429; a counter error returns 500 (fail closed); remaining attempts = 5 - attempts used.
- Both refuse a code whose row is `verified` ("Reset code has expired or was already used"). The wording keeps the word "expired" because `useAuthForm.ts` sends the user back to the code step when the error contains "expired". The frontend was not touched.
- `send` uses Lovable's `otp_reserve_send` (same function as `sms-otp`) with the key `reset_<last 9 digits>`: per-phone 3/hour (the previous policy), 60 s cooldown, per-IP 10/hour and 30/day, all counted in one locked step. A still-valid code is reused WITHOUT resetting its wrong-try count. The in-memory limiter is removed.

## Tested (local throwaway Supabase, real file, fake data, both real migrations)
- Normal flow send -> verify -> verify-and-reset works; the new password signs in (200), the old one does not (400).
- Same code again: 400 "expired or was already used"; the attempted password did not take effect; the real new password still works.
- 30 simultaneous wrong guesses: exactly 5 x 400 and 25 x 429, 30 attempts stored; the CORRECT code afterwards: 429.
- Resend after lockout: attempts stayed at 31 (was 30 plus the one correct try), not reset to 0.
- 8 simultaneous sends: 1 x 200, 7 x 429, exactly 1 code issued.
- With `register_otp_attempt` removed: the right code returned 500 and the password was NOT changed.

## Production prerequisites: VERIFIED 2026-11-03 (read-only queries on the live database)
`register_otp_attempt(uuid)`, `otp_reserve_send(...11 args)` and `otp_check_code(text, text)` all exist in `public`, executable by `service_role` only (`anon` and `authenticated` are false). The `otp_reserve_send` argument list is exactly what this function passes. `otp_verifications` has every column the functions write (`attempts, expires_at, last_sent_at, otp_code, phone, send_count, send_status, send_status_at, send_status_reason, send_window_start, updated_at, verified, verified_at`) and `otp_send_events` has `user_id, phone, ip, outcome, created_at`. This does not prove the functions behave identically to the migration file; the local test ran the migration file's version.

## Deploy order (production)
1. `register_otp_attempt(uuid)` exists in production (applied by hand 2026-11-02, doc 251).
2. `otp_reserve_send(...)` and `otp_check_code(...)` exist in production (Lovable migration `20261102093911_975da3ee-...`). `sms-otp` on `origin/lovable` already needs them. Repo migrations do not faithfully reflect production, so confirm in the live database that both exist and are executable by `service_role`.
3. Only then deploy `password-reset-sms`. If step 2 is missing, every reset `send` returns 500.

## Behaviour changes to know about
- A person who mistypes the code 5 times is locked on that code until it expires (up to 1 hour), because a reused code keeps its count. Same trade-off `sms-otp` already has upstream.
- The happy path uses 2 attempts (the `verify` pre-check, then `verify-and-reset`). A weak-password rejection then costs one more attempt per retry.
- The per-IP cap is shared with `sms-otp` (same `otp_send_events` table).

## Still open in this function (reviewed, not changed)
1. `send` returns 404 "No account found with this phone number", so anyone can test which phones have Welile accounts.
2. `generateOTP()` still uses `Math.random()`.
3. `admin_reset`, `admin_reset_password` and `admin_delete_user` (caller check is correct: manager / super_admin / cto) write no `audit_logs` row, only a console line.
4. Passwords of 6 characters are accepted (server and frontend).
5. A successful reset also sets `email_confirm: true` and resets every account on the phone, by design; a recycled or SIM-swapped number therefore reaches all of them.
6. `x-forwarded-for` first value is client-settable, which weakens the per-IP cap.
