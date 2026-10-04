---
name: Rent fee edit notification
description: Every admin edit to rent fees/terms is logged and alerted by email to pexpert46@gmail.com only — never the finance anomaly recipients
type: constraint
---
Admins MAY edit tenant rent terms, but never silently.

- DB trigger `trg_log_rent_amount_change` (fn `log_rent_amount_change`) logs old→new for `rent_amount`, `duration_days`, `access_fee`, `request_fee`, `total_repayment`, `daily_repayment` into `rent_amount_change_log` with a `changed_fields` array.
- The `rent-amount-change-notify` edge function emails the report.

**RECIPIENT RULE (2026-08-02, user correction):** rent fee edit alerts go to **`pexpert46@gmail.com` ONLY**. Do NOT read recipients from `finance_anomaly_alert_config`, and do NOT send SMS for this alert — that config/phone pair is reserved for finance anomaly scans (joshwanda17@gmail.com / +256704825473) and must not be reused here.

**Why:** rent fee edits are a tenant-fraud control owned by a different reviewer than finance anomaly monitoring; mixing the two floods the finance channel and hides rent edits.

Out-of-band SQL corrections to rent terms must insert the log row and invoke the notify function in the same turn.
