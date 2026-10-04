---
name: Withdrawable Drift Alerts
description: Configurable UGX-threshold detector that alerts CFO when wallet.withdrawable_balance deviates from baseline + ledger Δ
type: feature
---

Automated detector for the strict withdrawable rule.

**Tables**
- `wallet_drift_alert_config` (single row): `low/medium/high/critical_threshold_ugx` (defaults 50K / 250K / 1M / 10M), `enabled` flag. CFO/Manager RLS.
- `wallet_withdrawable_drift_alerts`: one open alert per user (unique partial index on status IN open/investigating). Captures cached vs expected withdrawable, deviation, direction (overstated/understated), severity, status, detection_run_id, resolution audit.

**Detection formula**
```
expected_withdrawable = max(0, baseline_withdrawable + (ledger_net_now − baseline_ledger_net))
deviation             = withdrawable_cached − expected_withdrawable
alert IF |deviation| ≥ low_threshold_ugx
```
Severity tier = highest threshold crossed.

**RPC**: `public.detect_withdrawable_drift_alerts()` SECURITY DEFINER, search_path=public.
- Iterates `wallet_ledger_baseline` joined with `wallets` and ledger sums (production+admin_correction).
- Upserts open alert per user; auto-resolves alerts that have fallen back below low threshold.
- Emits `system_event` `wallet.drift_alert.raised` for new high/critical alerts (Trust Mission compliance).
- Returns jsonb summary (run_id, new_alerts, updated_alerts, auto_resolved, total_deviation_ugx, thresholds).

**Cron**: `detect-withdrawable-drift-alerts-every-15min` runs at minute 5/20/35/50 (offset from `detect-phantom-wallet-drift-every-15min`) via net.http_post to the RPC.

**UI**: `src/components/cfo/WithdrawableDriftAlertsPanel.tsx` mounted in CFO Dashboard → Reconciliation tab above the existing `PhantomDriftPanel`. Includes filters, summary tiles, "Run Scan Now", and a "Thresholds" dialog editing the config row + enabled toggle.

**Out of scope**: no automatic balance clamp; CFO decides resolution. SMS escalation can be wired later via Inngest from the `wallet.drift_alert.raised` event.
