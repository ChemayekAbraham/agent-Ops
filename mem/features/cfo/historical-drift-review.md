---
name: Historical Drift Review Queue
description: CFO-only queue for explicit release or write-down of phantom cached withdrawable balances frozen by the 2026-04-29 fresh-start anchor
type: feature
---
Tables: `wallet_fresh_start_anchors` (per-user anchor_at + frozen pre_anchor_ledger_net), `wallet_historical_drift_review` (one row per anchored agent, statuses: pending_review | approved_release | approved_writedown | escalated).

RPCs (CFO/manager only, both require ≥10-char reason, both write to `audit_logs`):
- `release_historical_drift(p_review_id, p_amount, p_reason)` — posts a balanced `admin_correction` (`system_balance_correction`) pair: wallet `cash_in` to user + platform `cash_out`. Lifts post-anchor production net so the cached value becomes withdrawable. Amount capped at `phantom_amount`.
- `writedown_historical_drift(p_review_id, p_amount, p_reason)` — posts the inverse pair: wallet `cash_out` from user + platform `cash_in`. Reduces cache to match production net. Amount capped at `cached_withdrawable`.

UI: `HistoricalDriftReviewPanel` is rendered inside the CFO Reconciliation tab between `PhantomDriftPanel` and `WalletReconciliationAuditPanel`. No batch / no automation — every decision is one explicit CFO click.

Backfill on 2026-04-29 seeded 34 agents (~93M UGX total phantom). Largest known: LUKODDA JOSEPH, ATUHAIRE, LOLEM FIRICILA. New agents are never anchored automatically.