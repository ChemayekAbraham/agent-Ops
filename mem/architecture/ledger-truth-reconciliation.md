---
name: Ledger-Truth Reconciliation (Production Mode)
description: reconcile_wallet_from_ledger RPC + wallet_ledger_truth_view + LedgerReconciliationPanel that align cached wallet balances to all-time double-entry ledger via balanced system_balance_correction pairs
type: feature
---
**Production-mode reconciliation toolkit (2026-04-30).**

- **View `wallet_ledger_truth_view`** — per-user diff: cached_balance, cached_withdrawable/float/advance, ledger_net (production wallet scope, all-time), drift_amount, drift_direction (`in_sync` | `phantom_air` | `hidden_owed`). `security_invoker = true`.
- **RPC `reconcile_wallet_from_ledger(p_user_id, p_reason)`** — CFO/super_admin/manager only, ≥10-char reason. Posts a balanced `system_balance_correction` ledger pair (wallet leg + platform leg, same `transaction_group_id`, classification `admin_correction`), then updates the cache via the `wallet.sync_authorized` session flag (only legal write path). Phantom-air writedowns drain withdrawable first then float; hidden-owed releases credit withdrawable. Writes `audit_logs(action_type='wallet_full_reconciliation', action='reconcile_to_ledger', metadata.reason=...)` and emits `system_events('wallet.reconciled_from_ledger')`.
- **Panel `LedgerReconciliationPanel`** — CFO Reconciliation tab, top of stack. Per-row "Reconcile" with reason dialog + bulk "Reconcile All" loop. Filters: drifting | phantom_air | hidden_owed | in_sync | all.

**Do not** bypass `apply_wallet_movement` for routine writes — this RPC is the only sanctioned path for cache-vs-ledger corrections, and only because it always writes a balanced ledger pair before mutating the cache.

Baseline at launch (2026-04-30): 78 drifting wallets, +54.4M phantom air, -78.6M hidden owed, total cache↔ledger gap UGX 178.9M. Target post-reconciliation: 0.
