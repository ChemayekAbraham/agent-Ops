# Stop mail going to placeholder addresses

## What I found (checked against live data)

Those addresses are not fake accounts — they are placeholders the system creates when somebody signs up with a phone number only and gives no email. Today:

- 46,665 people have an address ending `@welile.agent`, 5,468 `@welile.user`, 5,227 `@noapp.welile.user`. Every one of these is a phone-only signup.
- 34,325 end in `@deleted.invalid` — these are closed/removed accounts, working as intended.
- Only about 4,900 people have a real address (Gmail, Proton, Yahoo, etc.), plus a handful of genuine typos people made themselves (`gmail.comm`, `gmsil.com`).

The real problem: **the app keeps trying to send email to those placeholder addresses.** 2,483 messages were handed to the mail provider, 2,567 are still queued waiting to go, and 152 already bounced. Receipts, float-funding notices, invites and broadcasts are all affected. That damages our sending reputation and fills the Emails screen with rubbish rows.

Why it happens: there is already a correct check that recognises placeholder addresses, but only some parts of the app call it. Most senders take the address straight off the profile and queue it.

The odd-looking domains you see in the Emails history (things like `tgtmgggggga5il.com`) come from the bot signup ring that was already removed — those accounts are gone, only their old email history remains.

## What I will change

1. Put the placeholder check in the single place every email passes through, so no sender can bypass it. Placeholder recipients are recorded as skipped with a clear reason instead of being sent.
2. Apply the same check in the queue worker, so anything already waiting is skipped rather than delivered.
3. Retire the 2,567 messages currently queued to placeholder addresses — marked skipped, never deleted, so the history stays intact.
4. Make the Emails screen show these as "No mailbox (phone-only account)" so the rows read clearly instead of looking like fake users.

People with phone-only accounts keep getting their SMS and in-app notifications exactly as now — nothing they receive today is lost.

## Not included

- No accounts are deleted, merged or renamed.
- The `@deleted.invalid` rows for closed accounts stay as they are.
- Genuine typo addresses are left alone (I can add a "did you mean gmail.com?" prompt later if you want).

## Technical detail

- Promote `isUnusableEmail` from `supabase/functions/_shared/twoFactorEmail.ts` into a shared `recipientMailbox.ts`, extended to cover `welile.agent`, `noapp.welile.user`, `deleted.invalid` and any `*.welile.user` subdomain, matching the regex already used by `resolve_owned_notification_email`.
- Enforce it in `supabase/functions/send-transactional-email/index.ts` right beside the existing suppression check, logging `email_send_log` with `status = 'suppressed'`, `suppressed_reason = 'placeholder_recipient'`, and returning `{ success: false, reason: 'placeholder_recipient' }` (200, so callers do not treat it as an outage).
- Same guard in `supabase/functions/process-email-queue/index.ts` before transport: skip terminally (no retry), since a placeholder address never becomes deliverable.
- One-off backfill via a live migration: pending `email_send_log`/queue rows whose recipient domain matches the placeholder pattern move to `suppressed` with the same reason. Append-only tables are not touched.
- Emails view label driven off `suppressed_reason`; presentation only.
- Verification: re-run the domain breakdown to confirm zero new `sent`/`pending` rows on placeholder domains, plus typecheck, `npm run guard:all`, and the heap-safe build.
