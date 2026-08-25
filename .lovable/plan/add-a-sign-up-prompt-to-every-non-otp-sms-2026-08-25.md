# Add a sign-up prompt to every non-OTP SMS

## What you get

Every outbound SMS except authentication/OTP messages gains one extra line:

```text
Not on Welile yet? Sign up: welileapp.com/wjoin
```

`welileapp.com/wjoin` is a permanent short link that resolves to
`https://welileapp.com/join?r=2c6569ce-f236-464f-91b8-e04a9a0c05a6` (your referral),
so every signup from an SMS is attributed to you and every tap is counted in the
existing short-link click analytics.

The prompt appears once per message, right under the existing support-contact
line, and never duplicates itself if a message already carries it.

## The short link

The platform already has its own shortener (`short_links` + `/:code` resolver
with click tracking), so no external service is needed. One row is seeded with
the fixed code `wjoin` pointing at `/join` with `r=<your id>`.

- Long form: `https://welileapp.com/join?r=2c6569ce-f236-464f-91b8-e04a9a0c05a6` (62 chars)
- Short form: `welileapp.com/wjoin` (19 chars)

`wjoin` is checked against existing app routes and existing short codes before
seeding; if it is taken, the nearest free 5-character variant is used and the
plan's copy follows it.

## Which messages get it

Included: all rent, collection, payout, deposit, wallet, withdrawal, promissory,
partner, landlord, merchant, HR, broadcast and report SMS.

Excluded (auth/OTP): `sms-otp`, `password-reset-sms`, `bulk-password-reset`,
`issue-landlord-payout-otp`, `agent-cash-deposit-create`, `agent-cash-deposit-resend`,
`finops-cash-deposit-initiate`, `finops-cash-deposit-resend`,
`cash-deposit-verify-code`, `cto-issue-temp-password`, `confirm-phone-account`.

Two special cases, per your instruction:

- `landlord-daily-guarantee-sms` currently ends with `welileapp.com/landlord-signup`.
  That link is replaced by `welileapp.com/wjoin`, and no second prompt is added.
- `send-signup-invite-sms` sends a personal `/join?t=<activation token>` link.
  That one is functional (it claims a specific pre-created account), so it stays
  as it is and gets no extra prompt.

Messages will grow by ~47 characters, which pushes some of them into a second
SMS segment. You chose to accept that.

## Technical detail

1. **Migration** — insert one `short_links` row: `code = 'wjoin'`,
   `target_path = '/join'`, `target_params = {"r": "2c6569ce-…"}`,
   `user_id = 2c6569ce-…`, guarded with `on conflict (code) do nothing`.
   No schema change; resolution and click counting already work through
   `resolve_short_link` / `record_short_link_click` and the `/:code` route.
2. **`_shared/smsFooter.ts`** — add `getSignupPrompt()` and extend the exported
   decorator so the composed tail is support footer + blank line + signup prompt.
   Idempotent on both lines (regex match on `welileapp.com/wjoin`). The URL and
   the whole prompt are overridable by env (`SIGNUP_SHORT_URL`) with the literal
   default baked in, matching how `SUPPORT_PHONE` works today.
3. **Opt-out mechanism** — new `_shared/smsSignupPrompt.ts` exporting
   `suppressSignupPrompt()`, which sets a process-global flag read by the
   decorator. Each OTP function listed above calls it at module top (they all
   already import the footer interceptor). A content-based backstop also skips
   messages containing `verification code`, `reset code`, `temporary password`,
   or `deposit code`, so a new OTP function can never leak the prompt.
4. **Application points** — the existing three: `smsFooterInterceptor.ts`
   (global fetch wrapper covering all inline provider clients),
   `sendSmsMultiProvider.ts`, and `yoolaPrimary.ts`. No per-function template
   edits beyond the two special cases above.
5. **`landlord-daily-guarantee-sms`** — `MESSAGE` constant edited to swap the
   signup URL.
6. **Deploy** — redeploy the affected edge functions (all functions importing the
   shared footer modules) after the migration.

## Verification

- Query the seeded row and confirm `resolve_short_link('wjoin')` returns
  `/join` with the `r` param.
- Load `https://welileapp.com/wjoin` in the browser harness and confirm it lands
  on the join page with the referral applied and the click counter incremented.
- Send one test SMS via `sms-test-send` and one OTP via `sms-otp` to your number,
  then read `sms_delivery_log` to confirm the prompt is present in the first and
  absent in the second.

## Not changed

No rent, wallet, ledger, eligibility or auth logic. No new tables, no new
provider, no template rewrites other than the single landlord marketing line.
