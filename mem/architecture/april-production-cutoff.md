---
name: April 2026 Production Cutoff
description: From 2026-04-01 onward, all general_ledger entries are forcibly tagged 'production' by trg_enforce_production_april_cutoff (only 'admin_correction' is allowed distinct). One-shot backfill on 2026-04-30 promoted 306 April-onward legacy_real/test_dev legs to production.
type: feature
---
**Cutoff: `transaction_date >= 2026-04-01 00:00:00+00` ⇒ classification = `production`.**

- **Trigger `trg_enforce_production_april_cutoff`** (BEFORE INSERT on `general_ledger`, SECURITY DEFINER, `search_path = public`): if `transaction_date >= 2026-04-01` and incoming `classification` is anything other than `production` or `admin_correction`, it is rewritten to `production`. `admin_correction` is intentionally preserved so reconciliation legs (posted by `reconcile_wallet_from_ledger`, `wallet-deduction`, `cfo-direct-credit`, `resolve-phantom-drift`) stay distinguishable for CFO audit.
- **Backfill (2026-04-30, one-shot)**: 296 `legacy_real` + 10 `test_dev` April-onward legs were promoted to `production` (306 total). Performed inside a single migration that briefly disabled `trg_prevent_ledger_update` then re-enabled it. Audited via `audit_logs.action_type = 'ledger_classification_backfill'` and `system_events.event_type = 'ledger_classification_backfilled'`.
- **Pre-April history is untouched** — `legacy_real` rows before 2026-04-01 stay where they are; CFO reports and the truth view continue treating them as production-scope via the existing `classification IN ('production','legacy_real')` filters.
- **Effect on `wallet_ledger_truth_view`**: 306 newly-production legs now contribute to ledger_net for affected users → expect new drift to surface in `LedgerReconciliationPanel`. Use the panel to settle.
- **Do NOT bypass the trigger.** New code paths must let the trigger normalize classification; only `admin_correction` may be explicitly set, and only by sanctioned reconciliation tools.
