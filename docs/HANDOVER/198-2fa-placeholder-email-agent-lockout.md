# 198 — 2FA accepted `@welile.agent` placeholder emails and locked agents out

**FIXED in code 2026-10-06 (edge function deploy pending).**

## Symptom
Agent Franco Wesinge (+256758908597) hit "Verify this device" on a new phone; the
code was "emailed" to `7********@welile.agent` and never arrived.

## Cause
`_shared/twoFactorEmail.ts::isUnusableEmail` listed only some synthetic domains and
omitted `welile.agent`. The mail transport guard (`_shared/recipientMailbox.ts::
isPlaceholderRecipient`) does block it. So 2FA could be enabled on a phone-only
account (`user_two_factor.email = <phone>@welile.agent`), and every code was
suppressed at send time. Nothing surfaced the failure to the user.

## Fix
`isUnusableEmail` now delegates to `isPlaceholderRecipient`, one list for both.
`two-factor-manage` therefore refuses to enable 2FA on any placeholder, and
`two-factor-challenge` skips a stored placeholder and falls back to
`profiles.email`.

## Live state (verified 2026-10-06)
User `8edfa2ba-5907-40a8-956f-efeda4d0c9d9`: `user_two_factor.enabled = true`,
stored email `701824548@welile.agent`, profile email `geonamgeon1@gmail.com`,
1 trusted device. After deploy the next code goes to the profile address.
**Confirm with the agent that this inbox is theirs before they request a code.**

## Not done
- No row was changed. An auto-disable for placeholder-only accounts was proposed and
  not applied.
- Other accounts with a placeholder in `user_two_factor.email` are not enumerated.
  Query: `select user_id from user_two_factor where enabled and email ilike '%@welile.agent'`.
- Deploy `two-factor-challenge` and `two-factor-manage` (both import the helper).
