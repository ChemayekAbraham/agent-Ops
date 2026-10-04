---
name: Pivot rebuild 2026-08-01
description: ledger_balance_pivot contents rebuilt from v_user_wallet_strict under CFO approval; backup table ledger_balance_pivot_2026_08_01_backup retained; job 41 threshold UGX 1,000 is locked
type: feature
---
**Executed 2026-08-01 (CFO-approved Steps 6-9).**

- `ledger_balance_pivot` was under-populated (30,786 rows) which produced ~310 false mismatches and ~UGX 109M apparent drift.
- Rebuilt in place from `v_user_wallet_strict` (167,769 rows). Same table kept, so dependent views (`wallet_pivot_drift_view`, `v_pivot_drift`), RLS, indexes and grants were preserved. Swap ran inside one transaction with row-count, total-sum and per-bucket invariants that abort on mismatch.
- Canary wallet 0704825473 (Joshua Wanda, `cb798acb-68bc-4b4e-a414-a3d374e030b6`) unchanged: withdrawable 1,703,118 + float 1,099,910 = 2,803,028.
- Real blast radius after rebuild: 2 wallets, net UGX +272 (Haddy Hadijah +300, Sharif Kc -28). All three affected/canary users were notified by SMS via `notify-wallet-reconciliation`.
- Backup: `public.ledger_balance_pivot_2026_08_01_backup` (30,786 rows, service_role only). **Retain at least 7 days** — do not drop before 2026-08-08.
- Cron job 41 `reconcile-wallets-from-pivot` re-enabled, `*/10 * * * *`. **Its UGX 1,000 auto-heal threshold must never be raised or removed without separate CFO approval.**
- No further wallet-layer cleanup (e.g. retiring `wallet_ledger_baseline`, collapsing wallet layers) for at least 48 hours of clean monitoring.
