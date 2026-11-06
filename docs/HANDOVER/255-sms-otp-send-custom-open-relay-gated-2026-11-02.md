# 255. sms-otp: open `send_custom` SMS relay gated (2026-11-02)

**Status:** WRITTEN AND TESTED LOCALLY, COMMITTED ON `dev/otp-attempt-limits`, NOT PUSHED, NOT DEPLOYED.

## Problem
`sms-otp` has `verify_jwt = false` (`supabase/config.toml`) and its `send_custom` / `custom` action had no caller check, so anyone with the public anon key could send any text, from the WELILE sender, to any number (phishing in Welile's name, SMS credit drain). The only legitimate caller found in the repo is `fraud-cutoff-account`, which uses a service-role client (`admin.functions.invoke("sms-otp", { body: { action: "send_custom", ... } })`).

## Change
In the `send_custom` branch of `supabase/functions/sms-otp/index.ts`: refuse with 403 `Forbidden` unless the `Authorization` bearer equals `SUPABASE_SERVICE_ROLE_KEY`. 11 lines; no other behaviour changed.

## Tested (local throwaway Supabase, real file, fake data; the test ran against the pre-Lovable-refactor copy of the file, the added block is identical)
No header, the public anon key and a wrong key all returned 403. The service key passed the gate (500 only because the local stack has no SMS provider keys). A service-role client calling `functions.invoke("sms-otp", { action: "send_custom" })`, the same shape `fraud-cutoff-account` uses, also passed. `verify` with a bad body was unaffected.

## Production key caveat (doc 253)
The production runtime's `SUPABASE_SERVICE_ROLE_KEY` does NOT match the key shown in the dashboard, and `help-center-sync` rejected a valid dashboard key because it compared the token to the runtime variable. This gate does the same comparison. An internal call (`fraud-cutoff-account` -> `sms-otp`) should still pass because both functions read the same runtime value, but a caller holding the DASHBOARD key (a cron, a manual curl) will get 403. If that bites, copy the fallback shipped in `help-center-sync`: also accept a token that passes an Auth admin call. **After deploying, trigger one fraud-cutoff notice, or call `send_custom` with the runtime key, and confirm the SMS is accepted before trusting the gate.** Any other caller outside this repo that relied on the open relay will now get 403.

## Already fixed upstream (do not redo)
`origin/lovable` already contains `otp_check_code` (locks the row, counts a wrong guess in the same step, 5-try limit) and `otp_reserve_send` (advisory locks on the send limits, keeps `attempts` when a code is reused), migration `20261102093911_975da3ee-...`. An earlier local draft of a `verify` counter change was DROPPED because of this.

## Still open in `sms-otp` (reviewed, not changed)
1. `verify` returns `success: true, already_verified: true` with no code for a phone whose row is already verified (`otp_check_code` returns `already_verified`). Impact depends on which callers trust that reply; not traced. A code is not tied to a purpose.
2. Codes are stored in plaintext in `otp_verifications.otp_code`, and the full SMS text including the live code is stored in `sms_delivery_log.message`. Who can read those tables was not checked.
3. ~~`generateOTP()` uses `Math.random()`~~ FIXED 2026-11-03 (now `crypto.getRandomValues` with rejection sampling; see doc 256 follow-up; tested, not deployed).
4. The per-IP send cap uses the first `x-forwarded-for` value, which a client can set.
5. The public `status` action reveals whether a number has used OTP and which provider handled it.
6. `password-reset-sms` has not been reviewed.
