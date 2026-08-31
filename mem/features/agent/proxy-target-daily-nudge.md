---
name: Proxy Target Mode daily nudge emails
description: Accepted Target Mode proxy agents get 3 promissory-note nudge emails a day (9am/12pm/3pm Kampala) via proxy-target-daily-nudge; target resets each Kampala month
type: feature
---
Target Mode progress is always computed for the current Kampala month (`get_proxy_target_mode`
uses `date_trunc('month', now() AT TIME ZONE 'Africa/Kampala')`), so notes and the reward
curve reset automatically on the 1st. Enrollment (`proxy_target_mode_enrollments.status`)
persists across months.

Daily nudges:
- Edge fn `proxy-target-daily-nudge` — accepted enrollments only, one bulk `promissory_notes`
  read (no per-agent fan-out for counts), sends template `proxy-daily-nudge` through
  `send-transactional-email` with idempotency key `proxy-nudge-<agent>-<date>-<slot>`.
- Cron jobs `proxy-target-nudge-morning|midday|afternoon` at `0 6/9/12 * * *` UTC
  = 9am / 12pm / 3pm Kampala, each posting `{"slot": ...}`.
- Copy angle: find someone willing to support a tenant's rent; they earn 15% of the rent they
  contribute monthly; a promissory note is a commitment, not a payment.
