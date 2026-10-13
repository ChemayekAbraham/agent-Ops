# 215 — Yoola credit outage: advance-deduction alerts had no fallback (2026-10-12)

**Status: BUILT 2026-10-12, edge function `notify-advance-deduction` not deployed.**

## What was checked (live `sms_delivery_log`, 2026-10-09 → 10-12)

- Yoola has returned HTTP 402 `insufficient_fund` since 2026-10-09 (~430 rows, still failing 2026-10-12 05:45 UTC). Last Yoola success 2026-10-11 06:03 UTC.
- The main paths already fail over correctly: `sms-otp` (402 is not retried, goes straight to Africa's Talking), `_shared/sendSmsMultiProvider.ts` (Yoola → AT → Lana), `password-reset-sms`, `gmail-poll-transactions`, `process-agent-advance-deductions`. Africa's Talking delivered ~840 messages in the last 48h.
- Daily failed counts: 10-04 251, 10-08 105, 10-09 71, 10-11 299, 10-12 150 (partial day). OTP failures that remain are Africa's Talking rejecting the number (`InvalidPhoneNumber`, `Delivery failed`, one 403) with Lana also out of credit, not a routing gap.

## The gap

`notify-advance-deduction` (fired by `trg_sms_advance_deduction`, source `advance_deduction_each`) called `attemptYoolaPrimary` and discarded the result. 53 per-deduction alerts hit Yoola 402 with no Africa's Talking row at all.

## Fix

`notify-advance-deduction` now sends through `sendSmsMultiProvider.sendSMS` (Yoola → Africa's Talking → Lana, audited in `sms_delivery_log`). No idempotency key: each deduction is its own alert. Response now includes `delivered`.

## Still open (not done here)

- Top up Yoola and Lana; Africa's Talking is carrying everything.
- A circuit breaker (skip Yoola for N minutes after a 402) would save one wasted call per message and keep the log clean. Not built.
- Deploy `notify-advance-deduction`.
