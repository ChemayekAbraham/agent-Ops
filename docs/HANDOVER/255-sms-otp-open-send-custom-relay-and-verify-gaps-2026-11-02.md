# 255. sms-otp: open `send_custom` SMS relay closed, `verify` gaps still open (2026-11-02)

**Status:** `send_custom` gate and the `verify` attempt-counter fix WRITTEN AND TESTED LOCALLY, NOT COMMITTED, NOT DEPLOYED. The other findings below are OPEN. Read-only review plus one change; nothing here has been run in production.

## Closed in this change
`sms-otp` has `verify_jwt = false` (`supabase/config.toml`) and its `send_custom` / `custom` action had no caller check, so anyone with the public anon key could send any text, from the WELILE sender, to any number (phishing in Welile's name, SMS credit drain). The only legitimate caller found in the repo is `fraud-cutoff-account`, which uses a service-role client.

The branch now refuses unless the `Authorization` bearer equals `SUPABASE_SERVICE_ROLE_KEY` (403 `Forbidden`).

Tested on a throwaway local Supabase (real `sms-otp` file, fake data): no header, anon key and a wrong key all returned 403; the service key passed the gate (500 only because the local stack has no SMS provider keys); a service-role client calling `functions.invoke("sms-otp", { action: "send_custom" })`, the same shape `fraud-cutoff-account` uses, also passed the gate; `verify` with a bad body was unaffected.

**Production key caveat (doc 253):** the production runtime's `SUPABASE_SERVICE_ROLE_KEY` does NOT match the key shown in the dashboard, and `help-center-sync` rejected a valid dashboard key for exactly this reason (it compared the token to the runtime variable). This gate does the same comparison. An internal call (`fraud-cutoff-account` -> `sms-otp`) should still pass, because both functions read the same runtime value, but a caller holding the DASHBOARD key (a cron, a manual curl) will get 403. If that bites, copy the fallback shipped in `help-center-sync`: also accept a token that passes an Auth admin call such as `auth.admin.listUsers`. After deploying, trigger one fraud-cutoff notice, or call `send_custom` with the runtime key, and confirm the SMS is accepted before trusting the gate.

**Not verified:** `fraud-cutoff-account` itself was not run (it needs many production tables); the production key format; any other caller outside this repo (a cron, Lovable function, or manual curl that relied on the open relay will now get 403). Deploy order: deploying `sms-otp` is safe at any time; roll back by redeploying the previous version.

## Open findings (not changed)
1. **`verify` attempt counter was racy. FIXED IN THE WORKING TREE (tested locally, NOT COMMITTED, NOT DEPLOYED).** It read `attempts`, added 1 in JavaScript and wrote back, so parallel guesses undercounted (30 parallel guesses recorded as about 4 in a local experiment). `verify` now calls `register_otp_attempt` (doc 251, same migration `20261102090000`, which MUST be applied to production first; it already is) before comparing, returns 429 above 5 and a 500 if the counter fails (fail closed). Local test of the real file on a throwaway Supabase: 30 simultaneous wrong guesses gave exactly 5x 400 and 25x 429 with 30 stored attempts; the correct code after lockout still got 429; a typo then the right code worked ("4 attempts remaining", then verified); with the counter function removed the right code got 500. **Correction to the first draft of this doc:** it called the `send` reset (`attempts: 0` while reusing a valid code) a serious hole. Guesses per hour are bounded by sends per hour (5) times attempts per send (5), about 25 per hour per phone, at 1-in-1,000,000 per guess whether the code is reused or fresh, so the reset adds little and `send` was left unchanged on purpose (changing it risks the "Invalid code" loop fixed at the "CRITICAL FIX" comment). The real bound on guessing is the send cap, which is itself read-then-write (finding 5).
2. **`verify` returns `success: true, already_verified: true` with no code** for a phone whose row is already verified. Impact depends on which callers trust that reply; not traced.
3. **Codes stored in plaintext** in `otp_verifications.otp_code`, and the full SMS text including the live code is stored in `sms_delivery_log.message`. Who can read those tables was not checked.
4. **`Math.random()` generates the code** (`generateOTP`); should use `crypto.getRandomValues`.
5. **Send-side limits are read-then-write** (race), and the per-IP cap trusts the first `x-forwarded-for` value, which a client can set.
6. **Public `status` action** reveals whether a number has used OTP and which provider handled it.
7. A code sent for one purpose can verify another (purpose is not stored with the code).
