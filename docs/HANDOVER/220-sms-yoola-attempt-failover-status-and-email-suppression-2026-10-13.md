# 220 — Rescued Yoola attempts marked `failover`; "37 notification failures" is email suppression; rollback sampler live (2026-10-13)

**Status: APPLIED to production 2026-10-13 by hand (same SQL as migration `20261013110000`).**

## 1. Rescued Yoola attempts are `failover`, not `failed`
Follows doc 219. Instead of editing ~24 senders, one trigger on `sms_delivery_log` (`sms_mark_rescued_yoola_attempts`, on INSERT and on status UPDATE to sent/accepted/delivered) flips a `status='failed'`, `provider='yoola'` row to `failover` when a later row for the same number AND same `source` succeeds within 10 minutes. `error` and `provider_response` are kept. It swallows its own errors, so it can never block a send. Covers future senders too.
- Same-source is stricter than the report's any-source rule: 4,456 of 4,718 rescued attempts match (94%); the other ~260 stay `failed` (conservative).
- Backfilled 30 days: 4,456 rows. 30-day status mix after: failed 6,666, failover 4,456.
- `sms_row_is_recovered` now also treats `failover` as recovered; `failover_recovered_30d` counts failed+failover. Report unchanged at `failure_rate` 8.6.
- **Readers now see a new status value** (`SmsDeliveryLogViewer`, `SmsFailoverAlerts`, `SmsExceptionsManager`, `OtpDeliveryLog`, `RecoverySmsLog`, cost report). Filters on `failed` now hide rescued attempts (intended); any status badge/legend needs a `failover` label (UI, Gemini).

## 2. "Outbound notification delivery failures" (37 users) is not a failure
Source is `email_send_log` (`status NOT IN ('sent','pending')`). On 10-12 every such row is `suppressed` (31 rows, 10 templates, withdrawal-paid-receipt, agent-tenant-payment-receipt, daily-agent-card, ...): the recipient address is on the suppression list, so the email was deliberately not sent. Zero `failed`/`bounced`/`dlq`; report p3 shows emails failed 0, delivery 100%. Not an SMS or credit problem. Open decision: doc `20260913150000` kept `suppressed` counted on purpose; consider a separate "suppressed" line (needs Josh's call, not changed).

## 3. Rollback sampler applied
Migration `20261012130000` (doc 218) applied: `db_rollback_minute`, `db_rollback_burst_evidence`, `capture_rollback_minute()`, cron `capture-rollback-minute` (jobid 42736, every minute). Read `db_rollback_burst_evidence` after the next nightly burst (~03:00 or ~06:00 EAT).
