# Investigation: 9 orphan wallet-scope ledger legs (user_id NULL, wallet_bucket NULL)

Opened: 2026-08-01 · Owner: CTO/CFO · Status: **findings complete, remediation pending approval**
Prerequisite check (2026-08-01): production wallet drift confirmed limited to the 2 already-notified wallets
(Haddy Hadijah −300 pivot vs cache, Sharif Kc +28); 55,894 wallets scanned, 0 wallets at/above the UGX 1,000
CFO gate, canary 0704825473 unchanged at UGX 2,803,028.

## Scope
`general_ledger` where `ledger_scope='wallet' AND user_id IS NULL AND wallet_bucket IS NULL`
→ 9 rows, gross UGX 544,780,988. Also noted: 2 `bridge`-scope legs with NULL user (UGX 1,020,000,
supporter facilitation capital) — separate, benign, out of scope here.

## Trace table

| # | leg id | created_at (UTC) | amount | dir | category | group | group balanced? | traced origin |
|---|--------|------------------|--------|-----|----------|-------|-----------------|---------------|
| 1 | 5c3a9455 | 2026-05-07 05:53:45 | 544,205,788 | cash_in | system_balance_correction | cc577b1a | **NO — single leg, no counterparty** | "negative balance wipe (pass 3, incl NULL bucket)", `source_table=manual_admin_action`, ref `be7ab395…`; part of a 3-pass wipe batch (86 + 5 + 18 legs) run manually 05:39–05:53 on 2026-05-07 |
| 2 | 2fe64844 | 2026-07-22 09:51:34 | 192,000 | cash_in | system_balance_correction | 76a2f1ef | yes (2 legs) | clawback of parent-agent listing-rejection over-refund; counterparty leg = **Watsala Enock** cash_out 192,000; idem `watsala-parent-rejection-overrefund-clawback-192k` |
| 3 | 9c080215 | 2026-07-26 10:28:43 | 9,500 | cash_out | agent_float_deposit | fd83ec59 | yes | manual TID recovery 152523174951; counterparty = **Muwanguzi Fred** float cash_in |
| 4 | c02f204b | 2026-07-26 10:30:28 | 9,500 | cash_in | agent_float_deposit | eb326cac | yes | reversal of #3 (admin_correction) — counterparty Muwanguzi Fred float cash_out |
| 5 | a4713931 | 2026-07-26 10:30:28 | 9,500 | cash_out | agent_float_deposit | b8a3cdc3 | yes | re-post of #3 as `production` — counterparty Muwanguzi Fred float cash_in |
| 6 | b2fd07b4 | 2026-07-26 10:31:16 | 32,000 | cash_out | agent_float_deposit | bb8051c4 | yes | manual TID recovery 152533398021 — **Williams Kyambadde** |
| 7 | b5197b68 | 2026-07-26 10:31:16 | 45,000 | cash_out | agent_float_deposit | e0c27adb | yes | manual TID recovery 152397747720 — **Williams Kyambadde** |
| 8 | 3181643c | 2026-07-26 11:02:58 | 85,000 | cash_out | agent_float_deposit | af0e3385 | yes | manual TID recovery 152537235912 — **Mukisa Enock** |
| 9 | 477f7d0a | 2026-07-26 11:02:58 | 192,700 | cash_out | agent_float_deposit | 7b57e48b | yes | manual TID recovery 152535261838 — **Ssekabembe Kenneth Derrick** |

## Findings

1. **Two distinct root causes, not one.**
   - Legs 2–9 (UGX 575,200 total) are the **company/platform side** of manually posted corrections and
     TID float recoveries. They are correctly balanced against a real user leg, but were mis-tagged
     `ledger_scope='wallet'` instead of `'platform'`. Because they carry no `user_id`/`wallet_bucket`,
     wallet routing ignores them — no user balance is affected. This is a **classification defect**.
   - Leg 1 (UGX 544,205,788) is a **single unbalanced aggregate leg** with no counterparty and no user:
     the "pass 3" negative-balance wipe posted one lump credit representing all NULL-bucket negative
     balances instead of one leg per wallet plus a platform offset. This is the material anomaly.
2. **No SMS/system-event or audit trail exists** for the 2026-05-07 wipe passes (`system_events` and
   `audit_logs` are empty for 05:30–06:10 that day) — it was executed as raw migration SQL before the
   current wallet write-lockdown was in place. `source_table='manual_admin_action'` is the only marker.
3. **No user impact today.** `ledger_balance_pivot` groups strictly by `user_id`+`bucket`, and
   `apply_wallet_movement` requires both, so all 9 legs are structurally invisible to wallet balances.
   Re-verified above: only the 2 known wallets drift, canary unchanged.
4. **Reporting impact is real.** Any query that sums `general_ledger` by `ledger_scope='wallet'` without
   grouping by user (CFO wallet-scope totals, reconciliation gross figures) is inflated by up to
   UGX 544.78M. Platform-scope reporting is unaffected.
5. Comparable NULL-user volume exists in `platform` scope (79,934 legs) which is expected and normal —
   platform legs are not user-owned. The defect is specifically NULL user on **wallet** scope.

## Remediation options (no changes made)

- **A (legs 2–9, low risk):** balanced ledger correction that re-posts each platform side under
  `ledger_scope='platform'` and reverses the mis-scoped wallet leg. Zero wallet impact by construction.
- **B (leg 1, needs CFO sign-off):** decide whether the 544.78M aggregate is (i) a legitimate one-time
  write-off that belongs in platform scope as an expense/write-down with a matching offset leg, or
  (ii) an artifact to be reversed entirely. Requires reconstructing the pre-wipe negative balances from
  the 2026-05-07 batch (109 legs, 3 passes) before any posting.
- **Hard rule for both:** correction only via balanced ledger entries. Never `UPDATE general_ledger`.

## Guardrail proposed (not implemented)

A `BEFORE INSERT` check on `general_ledger` rejecting `ledger_scope='wallet'` rows with NULL `user_id`,
forcing such legs to `platform` scope. Would have prevented all 9.
---

## CFO decision — 2026-08-01 (executed)

**Pivot migration:** approved for completion (closed).

**Legs 2–9 (8 legs, UGX 575,200) — administrative reclassification only, no financial adjustment.**
Ledger rows are immutable by design (`prevent_ledger_mutation`), so the correction is recorded in the
append-only register `public.ledger_scope_reclassifications` (`original_scope='wallet'` →
`effective_scope='platform'`, reason + approver stored per row). Reporting reads
`v_general_ledger_effective.effective_ledger_scope`. No reversal, no write-off, amounts untouched.

**Leg 1 `5c3a9455` (UGX 544,205,788) — Historical Migration Anomaly, Under Investigation.**
Formal incident **FIN-2026-08-001** opened in `public.ledger_anomaly_incidents`
(`status='under_investigation'`). The leg is registered in `public.ledger_anomaly_isolations` and is
therefore excluded from `v_general_ledger_operational`. The ledger row itself was **not** modified,
reversed, written off or deleted. Next action required: forensic reconstruction of the 2026-05-07
migration batch (109 legs, 3 passes) to recover the intended balancing entry. Only if reconstruction
proves impossible may Finance decide on an administrative correction.

## Guardrails implemented

1. `zz_enforce_wallet_scope_requires_user` (BEFORE INSERT on `general_ledger`) rejects
   `ledger_scope='wallet'` with `user_id IS NULL`, unless a named migration window is open.
2. `begin_ledger_migration(p_migration_id, p_operator, p_reason)` — CFO/Manager/Super Admin only;
   requires migration identifier, operator and a ≥10-char reason; writes `audit_logs` and a
   `system_events` row; sets the transaction-local bypass. No migration can create financial records
   anonymously.
3. Transaction-group balance is already enforced by the existing deferred constraint trigger
   `trg_enforce_ledger_group_balance` (cash_in must equal cash_out per group).
4. **NULL `wallet_bucket` is monitored, not blocked.** 151,759 existing wallet-scope legs carry a NULL
   bucket (it is derived downstream from `recipient_type`), so a hard reject would halt production.
   Surfaced via `v_wallet_legs_missing_bucket` for review instead.
