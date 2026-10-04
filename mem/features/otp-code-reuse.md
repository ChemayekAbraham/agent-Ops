---
name: SMS OTP code reuse on resend
description: Login OTP send reuses the still-valid code instead of minting a new one, fixing the recurring "Invalid code" loop caused by delayed/out-of-order SMS
type: feature
---
# SMS OTP code reuse on resend

`otp_verifications` has a UNIQUE(phone) constraint and is single-row per phone
(upsert by `phone`). Login uses `sms-otp` action `send` to store/send the code
and `otp-login` to verify (NOT `sms-otp` `verify`).

**Rule:** `sms-otp` `send` MUST reuse the existing code when it is still valid
(unverified AND unexpired), and only generate a fresh code when none is usable.
Expiry of a reused code is preserved (never extended by resends).

**Why:** SMS in our markets is frequently delivered late and out of order. If
each resend overwrote `otp_code` with a new value, a user who received an
earlier SMS would type a code that no longer matches the single stored value and
fail forever ("Invalid code. Please check and try again."). Reusing the code
guarantees every SMS the user holds for that number contains the same working
code.

Do NOT drop the UNIQUE(phone) constraint — `password-reset-sms`,
`self-update-phone`, and `whatsapp-login-link` all upsert by `phone`.

UI: the "Sent to" line in `src/pages/Auth.tsx` shows the normalized full number
via `getFullOtpPhone(...)` (strips the stray leading 0), matching what was sent.
