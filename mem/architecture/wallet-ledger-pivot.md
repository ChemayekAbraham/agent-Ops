---
name: Wallet ↔ Ledger pivot
description: v_user_wallet_strict is the canonical pivot/comparator between wallets cache and general_ledger; all drift detection compares through it
type: feature
---
`v_user_wallet_strict` is the **pivot table** of the financial system. Every drift detector, balance gate, and reconciliation compares the cached `wallets` bucket totals against the anchor-aware ledger net **through this view** — never directly against raw `general_ledger` sums.

- It joins `general_ledger` (truth) with `wallet_fresh_start_anchors` (per-user cutoff) and produces the strict per-user figure.
- `wallets` is a view on top of it; `get_user_available_balance` reads it; `detect_phantom_wallet_drift` compares cached buckets to its output.
- When explaining or debugging drift, always frame the comparison as: `wallets cache  ⇄  v_user_wallet_strict (pivot)  ⇄  general_ledger`.
- Drift tables themselves move no money; they only record where the pivot disagrees with the cache.
