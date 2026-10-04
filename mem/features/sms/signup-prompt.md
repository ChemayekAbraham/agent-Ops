---
name: SMS sign-up prompt (welileapp.com/wjoin)
description: Every non-OTP SMS ends with "Not on Welile yet? Sign up: welileapp.com/wjoin"; OTP senders opt out via _shared/noSignupPrompt.ts
type: feature
---
# SMS sign-up prompt

Every outbound SMS except auth/OTP carries, after the support footer:

`Not on Welile yet? Sign up: welileapp.com/wjoin`

- `wjoin` is a seeded `short_links` row (code `wjoin`, `/join`,
  `{"r":"2c6569ce-f236-464f-91b8-e04a9a0c05a6"}` — Kalyango Timothy). Resolved by
  the catch-all `/:code` route (`TrackedRedirect`), so taps increment
  `click_count`. Do not create a duplicate/alternate join code.
- Composed in `_shared/smsFooter.ts` (`getSignupPrompt`, `withSignupPrompt`
  inside `appendSupportFooter`), so it applies at all three send points:
  `smsFooterInterceptor.ts`, `sendSmsMultiProvider.ts`, `yoolaPrimary.ts`.
  Override URL with env `SIGNUP_SHORT_URL`.
- Idempotent: skipped when the body already contains the join URL.
- **OTP / auth exclusion:** those functions do `import "../_shared/noSignupPrompt.ts";`
  as the FIRST line (sms-otp, password-reset-sms, bulk-password-reset,
  issue-landlord-payout-otp, agent-cash-deposit-create/-resend,
  finops-cash-deposit-initiate/-resend, cash-deposit-verify-code,
  cto-issue-temp-password, confirm-phone-account) — plus
  `send-signup-invite-sms` (already sends a personal `/join?t=<token>` link).
  Content backstop in `_shared/smsSignupPrompt.ts` also skips bodies mentioning
  verification/reset/temporary-password/deposit code or OTP.
- `landlord-daily-guarantee-sms` marketing copy now links `welileapp.com/wjoin`
  (replaced the old `/landlord-signup` link) and gets no second prompt.
