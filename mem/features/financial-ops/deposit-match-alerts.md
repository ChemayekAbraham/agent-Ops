---
name: Deposit match failure alerts
description: Configurable-window ops alerting when a deposit submission or an incoming email receipt fails to match
type: feature
---
`detect_deposit_match_failures()` (security definer) raises rows in
`deposit_match_alerts` for two classes, both scoped to the last 7 days:

- `deposit_unmatched` — `deposit_requests.status='pending'` older than the
  window with no gmail_transactions row linked and no TID digit-match
  (`normalize_momo_tid`).
- `email_receipt_unmatched` — incoming `gmail_transactions`
  (mtn_momo|airtel_money, direction='in') older than the window with
  `linked_deposit_request_id IS NULL` and no non-reversed
  `email_routing_history` row.

Config singleton `deposit_match_alert_config` (id=1): `enabled`,
`window_minutes` (default 30, 5–1440), `min_amount`, `notify_emails[]`.
Severity escalates warning → high (3× window) → critical (8× window).
Alerts auto-resolve when the deposit leaves pending or the receipt gets
linked/routed. Unique on (alert_type, subject_id) so re-runs update, never
duplicate.

Delivery: edge fn `deposit-match-alert-notify` (cron
`deposit-match-alert-notify`, every 15 min) runs the detector, emails all
open alerts with `notified_at IS NULL` to `notify_emails` via
`enqueue_email('transactional_emails', ...)` FROM `Welile Reports
<info@welile.com>`, then stamps `notified_at` so each alert is emailed once.
