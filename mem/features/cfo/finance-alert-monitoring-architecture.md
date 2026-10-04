---
name: Finance alert monitoring architecture
description: Classified finance anomaly monitoring — category rollups, materiality routing, alert lifecycle states, fingerprint suppression, CFO monitoring health panel
type: feature
---
Replaces the old flat "WELILE FINANCE ALERT [CRITICAL]" blast.

**Classification (mandatory)** — every check in `detect_finance_anomalies` carries exactly one
`category`: `financial_integrity`, `business_rule`, `operational`, `comparator`,
`presentation`, `monitoring`. Only `financial_integrity` amounts may be called
"financial exposure". Comparator/monitoring/presentation amounts are monitoring-layer
figures and must never be summed into an exposure headline.

**Routing** — `finance_anomaly_alert_config.sms_materiality_ugx` / `email_materiality_ugx`.
`run_finance_anomaly_scan(trigger_source)` returns `notify_channel`:
`sms` (material financial integrity breach) → SMS + email; `email` → email only;
`dashboard` → stored only; `heartbeat` → identical fingerprint, stored only; `none` → clean.
Edge fn `finance-anomaly-scan` obeys `notify_channel` and never re-derives severity.
Recipients stay the explicit allow-list (see mem://constraints/finance-anomaly-alert-recipients).

**Lifecycle** — `finance_anomaly_alert_states` (per check_key): NEW → ACTIVE → ACKNOWLEDGED
→ RESOLVED, plus HISTORICAL for immutable pre-cutoff artifacts. Ack via
`acknowledge_finance_anomaly_alert(p_check_key, p_note)`.

**Fingerprinting** — MD5 over per-check counts/severities; identical fingerprint records a
heartbeat instead of paging. Every scan is still persisted in `finance_anomaly_scans`
(`categories` jsonb, `notify_channel`, `notification_reason`, `alert_fingerprint`,
`fingerprint_repeat`) for full audit.

**Performance** — `run_finance_anomaly_scan` and `detect_finance_anomalies` carry
`SET statement_timeout = '180s'`; the scan takes ~15s and times out under the default
API statement timeout without it.

**UI** — `src/components/cfo/FinanceMonitoringHealthPanel.tsx`, CFO dashboard →
Reconciliation tab: separate sections for Financial Integrity, Operational Quality,
Comparator Health, Monitoring Health, Presentation, Historical artifacts, plus the
scan audit trail and a manual "Run scan".
