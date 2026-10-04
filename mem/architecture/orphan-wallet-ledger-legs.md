---
name: Orphan wallet ledger legs — FIN-2026-08-001
description: CFO-decided outcome for the 9 NULL-user wallet-scope ledger legs; 8 reclassified via append-only register, the UGX 544,205,788 leg isolated under incident FIN-2026-08-001 and deliberately left unchanged
type: feature
---
Investigated 2026-08-01; CFO decision executed the same day. Full trace: `docs/investigations/orphan-wallet-ledger-legs.md`.

- **8 legs (UGX 575,200)** were the company side of balanced manual clawbacks / TID float recoveries mis-tagged `ledger_scope='wallet'`. Corrected as **classification only** — recorded in the append-only register `ledger_scope_reclassifications` (wallet → platform, reason + approver). Ledger rows are immutable; never UPDATE `general_ledger`.
- **Leg `5c3a9455` (UGX 544,205,788, 2026-05-07)** is an unbalanced orphan journal entry from raw migration SQL. Status: **Historical Migration Anomaly — Under Investigation**, incident **FIN-2026-08-001** in `ledger_anomaly_incidents`, isolated via `ledger_anomaly_isolations`. **Do not write off, do not reverse, do not delete.** Requires forensic reconstruction of the 2026-05-07 batch (109 legs, 3 passes) before any accounting action.
- **Reporting rule:** financial/operational reporting must read `v_general_ledger_operational` (isolated legs excluded) or `v_general_ledger_effective.effective_ledger_scope` (applies the reclassification) — never raw `general_ledger.ledger_scope` for scope totals.
- **Guardrails:** `zz_enforce_wallet_scope_requires_user` rejects wallet-scope inserts with NULL `user_id`; the only escape is `begin_ledger_migration(migration_id, operator, reason)` (CFO/Manager/Super Admin, ≥10-char reason, writes `audit_logs` + `system_events`). Group balance stays enforced by `trg_enforce_ledger_group_balance`. NULL `wallet_bucket` is monitored via `v_wallet_legs_missing_bucket`, not blocked (151,759 legitimate rows).
