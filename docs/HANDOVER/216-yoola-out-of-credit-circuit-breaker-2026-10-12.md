# 216 - Yoola out-of-credit circuit breaker (2026-10-12)

**Status:** BUILT 2026-10-12, edge functions not deployed.

## Finding
Yoola has returned HTTP 402 `insufficient_fund` since 2026-10-11 06:03 UTC. The
fallback to Africa's Talking already worked (714 AT sends on 10-12), but every
message still made a doomed Yoola call first and logged a `failed` yoola row
(~400/day), which inflated the SMS failure rate in reports.

## Change
- New `supabase/functions/_shared/yoolaCircuit.ts`: per-isolate breaker. A 402 /
  `insufficient_fund` trips it for 10 minutes; a successful Yoola send resets it.
  After the cooldown one call probes Yoola, so a top-up is picked up automatically.
- `_shared/yoolaPrimary.ts` (`attemptYoolaPrimary`): returns false immediately while
  open, so the ~40 callers fall straight through to their AT path.
- `_shared/sendSmsMultiProvider.ts` (`sendViaYoola`): returns null (not attempted)
  while open, so `sendSMS` goes Yoola -> AT -> Lana without a failed Yoola trail entry.

## Not covered
`sms-otp`, `password-reset-sms` and `send-signup-invite-sms` carry their own inline
senders and do not use the shared breaker; they still fall back to AT correctly but
still log the Yoola 402 rows.

## Deploy
Redeploy edge functions that import the two shared files. Yoola still needs topping up.
