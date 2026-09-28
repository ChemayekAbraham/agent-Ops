# 144 — Architecture map corrected against production (2026-09-28)

`architecture-map.html` was a reskinned generic "AI coding assistant" template with figures from
2026-09-09 and several safety claims that were false. Every figure and claim was re-checked against
the live database and repo on 2026-09-28 and the map was rewritten to match.

## False claims that were removed

| Map said | Reality (2026-09-28) |
|---|---|
| `maintenance_mode` "locks all writes immediately"; Runbook 1 step 1 flips it | No DB function reads it. Only the UI lock screen and the 32 of 388 edge functions that import `_shared/treasuryGuard` honour it. Crons, RPCs and the other 356 functions keep writing. |
| Imbalance alerts "0 in 30d, Baseline OK" | `detect_ledger_group_imbalances()` has **no cron job**. It ran once (2026-07-23) and left 2,195 alerts (~UGX 293M) unresolved. |
| "Every transaction group balances" | True for multi-leg groups (0 unbalanced in 30d). The check excludes **1,256 single-leg groups (~UGX 146M)** in the same window. |
| `create_ledger_transaction` is the single door | 13 other public functions `INSERT INTO general_ledger` directly (listed in the map's Ledger Core drawer). |
| MTN MoMo / Airtel webhooks feed the edge functions; Runbook 3 "webhook storm" | No telco webhook exists. Money-in = IFTTT-forwarded SMS → payments Gmail → `gmail-poll-transactions` (every **1** min, not 2) → `email-auto-create-deposits` (2 min); plus `ussd-callback`. Runbook 3 replaced with "deposit paid but not credited". |
| `phantom_wallet_drift` detector | No such object. Real one: `detect_wallet_projection_drift`, cron `wallet-projection-drift` every 15 min. |
| DR extensions include `pgjwt`, `vector` | Neither installed. Actual: pg_cron, pg_net, pg_stat_statements, pg_trgm, pgcrypto, pgmq, postgis, supabase_vault, uuid-ossp. |
| DR rebuild has no data step | Added: the old weekly backup only captured 1,000 rows/table; the full ledger backup exists only since 2026-09-27 (doc 141) and covers the ledger only. |
| "Never reintroduce service workers" | `public/sw.js` exists (push-only, no caching). Rule reworded to "never add a caching worker". |
| Runbook 2 checks float only | Now checks `treasury_controls` first — `landlord_payouts_blocked = true` since 2026-09-25. |
| "Emergency Pause" button | Relabelled "Pause (demo)"; its message now says nothing was changed. |

## Figures updated

Ledger rows 460,457 → 627,405 · groups 215,482 → 297,457 · edge functions 342 → 388 · cron jobs
151 → 204 (9 inactive) · treasury_controls 19 → 22 · allowlisted categories 120 → 160 · tables 641 → 763
· functions 1,907 → 2,473 · triggers 601 → 682 (39 on `general_ledger`) · RLS 1,552 → 1,714 · views
71/6 → 96/7 · buckets 27 → 31 · auth users 62,098 → 96,974 · migration files 3,203 → 3,549.

## Structural changes

- Removed the "AI Assistant Spec" mode, its data and `switchMode()`; node IDs renamed from template
  names (`dev-ide`, `ai-model`, `git-repo`…) to real ones (`client`, `ledger-core`, `gmail-poller`…).
- New chapter **08 Known Gaps**: the three broken safety nets above, plus subsystems still without a
  box (merchant float/desk funding/OOP, Realtime, critical-function drift scan — runs every **5** min,
  auth sign-in race, backups).
- Chapter 07 gained traps 8 (treasury RPC) and 9 (merchant "owed" buckets are not debt).

## Still open (not done here)

1. DB-level `maintenance_mode` guard in `create_ledger_transaction` **and** the 13 direct inserters —
   money-path change, needs sign-off.
2. Schedule `detect_ledger_group_imbalances()` and triage the 2,195 alerts.
3. Confirm whether the 1,256 single-leg groups are covered by `sofp_ledger_legs` synthetic legs.

Counts in the map are a snapshot; re-run the catalog queries in chapter 06 rather than trusting them.
