# 219 — CTO report counted Yoola attempts that Africa's Talking rescued as SMS failures (2026-10-13)

**Status: BUILT, migration `20261013100000` not applied.**

## Finding
Every send path tries Yoola, then Africa's Talking, then Lana, so a Yoola out-of-credit (402) should never leave a user without an SMS. It does not. But `attemptYoolaPrimary` (`_shared/yoolaPrimary.ts`) and ~24 inline senders write one `sms_delivery_log` row **per attempt**, so each Yoola 402 leaves a `status='failed'` row even when AT delivered the same message seconds later. `get_cto_daily_report` counted those rows as failures.

Measured 10-11 → 10-12: 567 Yoola 402 rows, 499 (88%) had a successful row for the same number within -1/+10 minutes.
30 days: 77,153 rows, 11,252 failed (14.6%), of which 4,962 recovered by a later provider and 548 bad numbers. Genuine undelivered: 5,742 (8.0% of non-recovered rows).

Last 402 failure: 10-12 11:48 EAT. None since the circuit breaker (doc 216) went live.

## Change (report definition only, no rows rewritten)
- `sms_row_is_recovered(status, phone, created_at)`: a failed row with a `sent`/`accepted`/`delivered` row for the same number (last 9 digits) in -1/+10 min.
- `sms_row_invalid_destination(error)`: `invalid_phone`, `InvalidPhoneNumber`, "invalid Ugandan", "no valid Ugandan", "has no phone on profile".
- `get_cto_daily_report` is patched in place by a DO block (the live body drifts from the repo, so it edits what is deployed and aborts if an anchor is missing). Recovered rows leave the `sms` and `otp` populations; `failed`/`failure_rate`/`sends_failed_30d` exclude bad numbers; new keys `invalid_destination`, `failover_recovered_30d`, `sends_invalid_destination_30d`.

## Not changed
- **"Outbound notification delivery failures" (37 users) is EMAIL**, from `email_send_log` (`status NOT IN ('sent','pending')`, e.g. suppressed), not SMS. The morning brief tying it to the SMS credit problem was wrong. Still open.
- Real remaining SMS failures: bad numbers (e.g. `+256652017467`, `yoola_422_invalid_phone_format` on `sms-otp` / `send-signup-invite-sms`), 21 withdrawal claims with no valid number, and AT "Delivery failed" after acceptance.

## Follow-up (not done)
Write the Yoola attempt row as `failover` instead of `failed` when a later provider delivers, in `yoolaPrimary.ts` and the inline senders, so `sms_delivery_log` itself is clean for other readers.

## Verify after applying
`select get_cto_daily_report(current_date)->'sms'` : `failure_rate` should be near 8, `failover_recovered_30d` about 5,000, `invalid_destination` about 550.
