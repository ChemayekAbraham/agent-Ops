# 60 — `sms-otp` in production was running a stale build; ~95% of OTP sends were failing, blocking phone signup

**Reported 2026-09-17 by Josh: "users are not able to sign up and the send SMS code is failing."**

## What was actually happening

Two separate things, one of which looked like the cause but wasn't:

1. **A transient Supabase project connectivity blip.** Josh's browser console showed every
   request to `wirntoujqoyjobfhyelc.supabase.co` (auth token grant, RPCs, even the
   `treasury_controls` maintenance-mode check) failing with `net::ERR_FAILED 522` (Cloudflare
   "origin connection timed out"). This also broke the Lovable `query_database` MCP tool for
   about 10-15 minutes (consistent `499 request_cancelled`, and a `get_project` call that hung
   for 2+ minutes). It resolved on its own — a later `select 1` succeeded, `treasury_controls`
   confirms `maintenance_mode.enabled = false` (never an intentional lockout), and
   `status.supabase.com` showed only "API Gateway: Degraded Performance" platform-wide, no
   incident specific to this project. Not the root cause of the ongoing complaint — just bad
   timing that made the first few minutes of investigation look like a full outage.

2. **The real, ongoing cause: `sms-otp` OTP delivery was failing for ~95% of attempts.**
   `sms_delivery_log` for `source like 'sms-otp%'` over the prior 24h:

   | Provider | Status | Count |
   |---|---|---|
   | Yoola (primary) | pending, never resolved | 70 |
   | Africa's Talking | failed — `status_405` | 51 |
   | LANA | failed — `lana_400_no_phone_number_provided_` | 51 |
   | Yoola | failed — `yoola_delivery_unconfirmed:sent` | 44 |
   | Yoola | failed — `network_error` | 6 |
   | Yoola | **accepted** | **10** |

   `yoola_delivery_unconfirmed:sent` does not appear anywhere in `supabase/functions/sms-otp/index.ts`
   in this repo (checked via `git log -S`), nor in any other function that logs with
   `source = 'sms-otp'`. The only code that produces an "unconfirmed delivery" reason at all is
   `_shared/yoolaDeliveryConfirm.ts` (used by `agent-cash-deposit-create`/`-resend`, which log
   under their own source names, not `sms-otp`) — and even that helper's current format is
   `yoola_unconfirmed_<detail>` (underscore), not `yoola_delivery_unconfirmed:<detail>` (colon).

   **Conclusion: the `sms-otp` function actually running in production is an older build than
   what's on `lovable`**, one that polls Yoola's delivery-report API and treats "not yet
   confirmed delivered" as a failure before cascading to Africa's Talking then LANA. Per doc 56,
   no provider has ever populated a real `delivered` status for anything — so that wait can never
   succeed, and nearly every OTP send eventually cascades all the way through the fallback chain,
   where Africa's Talking is separately rejecting everything with HTTP 405 and LANA is separately
   rejecting everything with "no phone number provided" (both look like their own, independent
   bugs in whatever is deployed — not investigated further this pass since Yoola alone carries
   the bulk of the volume).

   This is what "SMS code sending is failing" actually was. It cascades directly into "users are
   not able to sign up": `phone-signup` requires an OTP verified within the last 30 minutes
   before it will create a phone-only account, so a code that never arrives blocks signup even
   though account-creation logic itself is fine — auth signups continued at a normal hourly rate
   throughout, and neither `signup_attempts` (agent-assisted path) nor the referrer velocity/fraud
   guards in `handle_new_user` show any blocking in the same window.

## What was checked and ruled out

- `scan_and_quarantine_dormant_referral_shells` (migration `20260916100000`, an unsupervised
  30-minute cron that auto-freezes/soft-deletes accounts on a "50+ referred, <5% active" bot
  heuristic) — **never actually deployed**: `select * from cron.job where jobname = '...'`
  returns zero rows in production. Not the cause, but still worth a second look before ever
  deploying it, given it has no human-review step.
- Signup velocity guard (5/hour, 10/day per referrer, `handle_new_user`) and the agent-assisted
  `record_agent_assisted_signup` cap — neither shows any `blocked`/rejected rows in the last 24h.
- Doc 49's "CTO dashboard signup_blocked false positive" — a different, already-fixed reporting
  bug from the day before. Unrelated to this.

## Fix

Deployed the current repo's `supabase/functions/sms-otp/index.ts` via
`.github/workflows/deploy-edge-function.yml` (added `sms-otp` to its function choice list and the
`EXPECT_PUBLIC` case, since `supabase/config.toml` already has `verify_jwt = false` for it —
called pre-signup/pre-login, no user session exists yet). That version only requires gateway
acceptance (HTTP-level "sent/queued"), not delivery confirmation.

**Not yet done:** Africa's Talking's `status_405` and LANA's `no_phone_number_provided` both look
like real, independent bugs in whatever is currently deployed for those fallback providers.
Deploying the current `sms-otp` build fixes the primary (Yoola) path, which carries most of the
volume, but the fallback chain should be verified/fixed separately before relying on it.
