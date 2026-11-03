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

## Follow-up, same day: three more items closed (tested locally, not deployed)
1. **No account enumeration on `send`.** An unregistered number now gets the same `200 {"success":true,"message":"Reset code sent"}` a registered one gets; nothing is sent or stored (verified: 0 `otp_verifications` rows, 0 `otp_send_events`). **Product impact:** a person who mistypes their number now sees "Code Sent", moves to the code step, and never receives a text. A way back ALREADY EXISTS (`src/pages/Auth.tsx`: the "Go Back" button under the form returns to the phone step with the number kept, and the subtitle shows the number the code was "sent" to), so no logic change was needed. What is missing is wording: the subtitle says "We sent a 6-digit code to X" and the button says "Didn't get the code? Resend SMS", which resends to the same wrong number and never says to check it. That copy was changed on Josh's explicit instruction (it is normally Gemini's lane; no markup or styling was touched): the subtitle on the code step (`src/pages/Auth.tsx` ~998) now reads "If an account exists for X, a 6-digit code is on its way."; the back button on that step (~1088) reads "Wrong number? Go back"; the toast in `src/hooks/useAuthForm.ts` ~355 reads "Check your phone / If that number has an account, a reset code is on its way." Not changed: the "Didn't get the code? Resend SMS" button, and the separate "Code Sent!" toast at `Auth.tsx:312` (a different flow, phone login). Only syntax-checked (TypeScript transpile, 0 errors); no UI test or visual check was run, and this worktree has no `node_modules`, so Gemini/Josh should look at the screen once. **Limits:** a registered number still takes seconds (the SMS provider call) while an unregistered one answers instantly, so timing still reveals it; `otp-login` returns "No account found" (404) after a valid code, and sign-up/login flows may reveal registration too. This closes the cheapest probe only.
2. **Secure codes.** `generateOTP()` in `password-reset-sms` AND `sms-otp` now uses `crypto.getRandomValues` with rejection sampling (draws at or above 4,294,000,000 are redrawn so all 1,000,000 codes are equally likely). Tested: 300,000 codes from each file's real function, all 6-digit, ~10% start with 0, even digit spread.
3. **Audit rows for admin actions.** `admin_reset`, `admin_reset_password` and `admin_delete_user` now write an `audit_logs` row (`action_type` `admin_password_reset` or `admin_delete_user`, `actor_id` and `user_id` = the admin, `target_user_id`, `table_name` `auth.users`, `record_id`, `ip_address`, `user_agent`, `metadata {function, via}`) BEFORE acting, and refuse the action (500) if the row cannot be saved (fail closed). The new password is never written. In production `audit_logs` is append-only (triggers block UPDATE, DELETE, TRUNCATE) and captures the IP itself. `user_id` is now validated as a UUID (400 otherwise), because a bad value would fail the audit insert. `requireAdminCaller` now returns `{ denied, callerId }` instead of a Response-or-null so the caller's id reaches the audit row. Tested: no token 401, non-admin 403 (0 audit rows), manager 200 with a correct row and no password in any field, audit table down -> 500 and the password unchanged, delete audited. Not tested: the production append-only triggers and IP trigger themselves (the lab emulated append-only); callers of the admin actions outside this repo (none in `src/`) will see 400 for a non-UUID `user_id`.

## Still open in this function
1. Passwords of 6 characters are accepted (server and frontend).
2. A successful reset also sets `email_confirm: true` and resets every account on the phone, by design; a recycled or SIM-swapped number therefore reaches all of them.
3. `x-forwarded-for` first value is client-settable, which weakens the per-IP cap.
