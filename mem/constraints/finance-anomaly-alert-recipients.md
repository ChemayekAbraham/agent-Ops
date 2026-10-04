---
name: Finance anomaly alert recipients
description: Finance anomaly alerts go ONLY to joshwanda17@gmail.com and +256704825473; never fan out to all CFO/CTO role holders
type: constraint
---
Finance anomaly alerts (`finance-anomaly-scan`) must be delivered ONLY to the explicit allow-list in `finance_anomaly_alert_config` — currently email `joshwanda17@gmail.com` and phone `+256704825473`.

Forbidden: any role-based fallback that resolves recipients from `user_roles` (cfo/cto) or `profiles` phone numbers. An empty `notify_phones` means "send no SMS", never "SMS everyone".

**Why:** on 2026-08-02 the empty `notify_phones` fallback blasted a CRITICAL finance alert with full exposure figures to 16 staff phones. Financial anomaly data is handled by one owner.