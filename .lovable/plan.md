# Rent Plan invitation text for new sign-ups

Send one short text message inviting new sign-ups to request rent from Welile, with a link into the platform.

## Who receives it

- Every account created from 1 August 2026 onward, regardless of role.
- Of those, 6,358 have a usable Ugandan phone number on file; the remaining accounts have no number stored and cannot be texted.
- Anyone on the existing do-not-text list is skipped.
- Each person receives this message once, ever — even if the send is re-run.

## When it is sent

- Backfill: one controlled batch for the 1 August 2026 onward group, run once and resumable if it is interrupted.
- Going forward: sent within seconds of the account being created, automatically, with no staff action.

## The message

Proposed wording (fits one to two message parts, includes their first name when known):

> Hi Grace, you can now request rent from Welile and pay it back in small daily amounts. Request your Rent Plan: welileapp.com/rent

Notes on the wording:
- Uses "Rent Plan" as required, never "loan".
- The link is a short, click-counted Welile link that opens the platform sign-in and takes them to their dashboard.
- The standard "Not on Welile yet? Sign up" line is suppressed for this message, because everyone receiving it already has an account. The support-contact line stays.

You can change the wording before we send; the final text is applied in one place.

## Safety

- Sending is throttled so the messaging providers are not overloaded.
- A dry run reports the exact recipient count before any real message goes out.
- Every send is logged (who, number, provider, outcome), so a repeat run sends nothing to someone already reached.
- No money, wallet, rent, or account data is changed by this work.

## Technical detail

- New edge function `notify-new-signup-rent-prompt`:
  - `mode: "backfill"` — pages `profiles` where `created_at >= 2026-08-01`, valid Ugandan phone, excluding `sms_message_exceptions`; batched with a small delay between sends; safe to re-invoke.
  - `mode: "single"` with `user_id` — one recipient, used by the sign-up trigger.
  - Uses the shared `sendSMS` helper from `_shared/sendSmsMultiProvider.ts` with `idempotencyKey: signup_rent_prompt:<user_id>`, `source: "signup_rent_prompt"`, so the existing SMS log enforces once-ever delivery.
  - Sets the existing signup-prompt suppression so the join link is not appended.
- Immediate trigger: `AFTER INSERT` trigger on `profiles` calling the function through `pg_net` (fire-and-forget, failure never blocks sign-up). Created with the data tool since it embeds the project URL and key, per project convention.
- Short link: one `short_links` row with code `rent` targeting `/auth`, so taps are attributed and counted like other Welile links.
- No schema changes beyond the single short-link row and the trigger; no changes to sign-up, wallet, ledger, or rent logic.

## Out of scope

- Changing sign-up flow, roles, or onboarding screens.
- Any second reminder or follow-up sequence.
- Accounts created before 1 August 2026.
