# 47 — SMS phone-collection gate blocked a valid caller-supplied destination

**Read this before touching `sendSMS` / `resolveProfilePhoneGate` in
`supabase/functions/_shared/sendSmsMultiProvider.ts`, or before assuming a repeated
"resend code" complaint means a provider outage.**

## What was found

Grace Paul Ochieng (`99890a2e-...`) reported retrying the withdrawal OTP twice with no
code ever arriving. Traced through `wallet_withdrawal_otp_challenges` →
`wallet_withdrawal_otp_events` → `sms_delivery_log`: **all 6 send attempts across two
challenges (2026-09-16, 12:30–14:32 UTC) failed identically** with
`"Blocked: recipient has no phone on profile (PhoneCollectionGate pending)"`.

Root cause: `sendSMS()`'s phone-collection gate (`resolveProfilePhoneGate`) re-validates
the recipient's `profiles.phone` field independently of whatever phone the caller actually
passed in, and hard-blocks the send if that profile phone isn't a Ugandan number — with no
exception for a caller that already resolved a perfectly valid alternate destination.

Grace's `profiles.phone` is **`+254733803035` (Kenyan)**. `issue-wallet-withdrawal-otp`
correctly computes `otpPhone` as her payout destination (`0787373498`, a verified Ugandan
MTN number — per its own documented logic, the OTP goes to the *payout* number when it's
usable, falling back to the account phone only otherwise) and passes that to `sendSMS`.
But `sendSMS`'s gate ignored the number it was just handed and re-checked
`profiles.phone` on its own, saw a non-Ugandan number, and blocked the send outright —
every time, unconditionally. Two earlier sends to her that same day (05:52, 08:18 UTC)
succeeded because they came from a different code path that never passes
`recipient_user_id`, so the gate never ran.

This is not specific to Grace — any user whose account phone is foreign but who has a
valid, verified Ugandan mobile-money payout number is permanently unable to receive a
withdrawal OTP, full stop, no matter how many times they resend.

## What was fixed

`sendSmsMultiProvider.ts`: the phone-collection gate now only runs when the caller-
supplied `phone` argument is *not already* a usable Ugandan number
(`!isUgandanPhone(effectivePhone)`), instead of unconditionally whenever
`recipient_user_id` is present. A caller that already resolved a valid destination is
trusted; the gate still applies exactly as before for any caller that didn't (empty/
invalid `phone`, relying on the profile-phone fallback) — so the original "don't waste
provider spend on a user who never completed phone collection" protection is unchanged
for every other caller of this shared function (45 call sites checked for the pattern).

## What was deliberately left alone

- Her payout destination (`0787373498`) is already `verified` — not the blocker, no
  action needed there.
- No backfill of the failed OTP attempts — she needs to retry once this is deployed;
  nothing to correct retroactively (no OTP was ever successfully generated to expire/waste).

## Still needs doing

**This is an edge function change — a git push does not deploy it.** Same gap as the
frontend CMO-dashboard fix earlier today: needs an actual function deploy before Grace (or
anyone else in her situation) can successfully get a code. Verify live with:
```sql
-- After Grace retries post-deploy, this should show a challenge with a "sent" event,
-- not another "Blocked: recipient has no phone on profile" failure.
select event_type, detail, failure_reason, created_at
from public.wallet_withdrawal_otp_events
where user_id = '99890a2e-b842-4d44-8516-e2eafe0711ff'
order by created_at desc limit 5;
```

## What not to do

- Don't remove the phone-collection gate entirely — it's still doing its job for callers
  that never resolved their own destination number.
- Don't "fix" this by changing Grace's `profiles.phone` to a Ugandan number — that's her
  real registered number; the bug was in the gate's logic, not her data.
