---
name: User-facing wallet view (hybrid model)
description: End-user wallet UIs read get_user_wallet_view RPC / v_user_wallet_strict view only. wallets.* cache stays for operator dashboards (CFO, FinOps, CEO, COO, CTO, HR, Manager, Executive). Build guard enforces the boundary.
type: feature
---
**Update 2026-08-14 — the RPC's internal data source has changed since this was written, and its
self-heal guarantee has partially regressed.** As of `20260811050458_wallet_projection_dirty_flag_deferral.sql`,
`get_user_wallet_view` reads `wallet_balances_projection` (a cached table with an `is_dirty` flag,
recomputed lazily by `wallet_projection_read_repair()` and a 2-minute `flush_dirty_wallet_projections`
cron) rather than deriving live from `v_user_wallet_strict` on every call as described below. The
2026-08-11 version of the RPC checked `is_dirty` and repaired before returning; a 2026-08-13 rewrite
(`20260813183746_87115a61-...sql:35-51`) that added pending-portfolio holds **dropped that check** — it
now only repairs when the row is missing entirely. `get_user_available_balance` lost its repair check
entirely in the same window (`20260813183622_a79bc578-...sql:33-46`), reverting to a plain read of the
projection. Freshness for both RPCs now depends on the 2-minute cron rather than repairing on every
read. See `mem/architecture/wallet-view-dirty-check-regression.md` and
`docs/investigations/Financial_Ops_Wallets_Merchant_Agents_Verified_2026-08-14.md`. The frontend
consumption rule below (call the RPC, never the raw cache) is still correct and unaffected.

---
**Rule.** Any wallet number a regular end user sees (tenant, agent, supporter, landlord) MUST come from `get_user_wallet_view(user_id)` (or a hook that wraps it: `useAvailableBalance`, `computeLedgerAvailable`, `useAgentBalances`). The `wallets` table (`balance`, `withdrawable_balance`, `float_balance`, `advance_balance`) is operator-only and is consumed exclusively by CFO, Financial Ops, CEO, COO, CTO, HR, Manager, and Executive surfaces for reconciliation work.

**Why.** The `wallets.*` cache can drift above the strict ledger position (phantom drift, anchor windows, missing legacy posts). Showing the cache to end users caused "Insufficient ledger balance" errors at withdrawal time and eroded trust. Reconciliation dashboards explicitly need to see the cache to fix it — they keep using it.

**How to apply.**
- New user-facing wallet code: call `useAvailableBalance(userId)` for the headline available figure, or `supabase.rpc('get_user_wallet_view', { p_user_id })` for all four buckets in one call.
- Never write `.from('wallets').select('balance|withdrawable_balance|float_balance|advance_balance')` in any file under `src/components/wallet/`, `src/components/payments/`, `src/components/agent/`, `src/components/supporter/`, `src/components/tenant/`, `src/components/landlord/`, `src/components/dashboards/`, or `src/pages/{agent,supporter,tenant,landlord}/`.
- Operator dashboards (any path containing `cfo`, `financial-ops`, `manager`, `executive`, `admin`, `ceo`, `coo`, `cto`, `hr`, `crm`, `cmo`, `reconcile`) are explicitly allowlisted to read `wallets.*` directly.
- `scripts/guard-frontend-ledger-writes.mjs` enforces this at build time.

**Database surface.**
- View: `public.v_user_wallet_strict(user_id, withdrawable, float_balance, advance_balance, pending_holds, total_visible)` — derives every bucket live from `general_ledger`, excludes admin corrections (`category <> 'system_balance_correction'`) and float-bucket categories from withdrawable, honors `wallet_fresh_start_anchors`, subtracts pending withdrawal holds, clamps each bucket at 0.
- RPC: `public.get_user_wallet_view(p_user_id uuid) RETURNS jsonb` — `SECURITY DEFINER`, `search_path = public`, granted to `authenticated, anon, service_role`. Returns the row as a JSON object so the frontend gets all four numbers in one round-trip.
- RPC: `public.get_wallet_totals_strict() RETURNS json` — `SECURITY DEFINER`, `search_path = public`, granted to `authenticated, service_role`. Operator-facing companion to `get_wallet_totals()`. Returns `{ strict_total, drifted_wallets, total_drift }` across all non-system wallets (excludes `06b14430-…`). `strict_total = SUM(strict withdrawable + strict float)` from `v_user_wallet_strict` for apples-to-apples comparison with cached `wallets.balance`. `drifted_wallets` counts wallets where `cached − strict > 100 UGX` (matches reconciliation tolerance). `total_drift = SUM(GREATEST(cached − strict, 0))` — the cache-excess sweep target. Used by Fin Ops `WalletOverviewCard` to surface drift under the cached headline; clicking it opens the Reconciliation tool.

**In scope (already migrated 2026-04-30):**
- `src/lib/computeLedgerAvailable.ts` — calls RPC, no cache reads.
- `src/hooks/useAvailableBalance.ts` — calls RPC, no cache reads.
- `src/hooks/useAgentBalances.ts` — calls RPC for buckets, ledger query for commission display only.
- `src/components/agent/AgentManagedUsersSheet.tsx` — calls RPC.
- `src/components/dashboards/SupporterDashboard.tsx` — uses `useAvailableBalance` for the empty-wallet nag trigger.
- `src/hooks/useWallet.ts` — **migrated 2026-05-01**: now strict-by-construction. Reads `get_user_wallet_view` and surfaces `withdrawable + float` as `wallet.balance` for back-compat. Never touches the `wallets` table. localStorage version bumped to `v4` so prior cached snapshots are evicted on next load.

**Explicitly out of scope (cache reads remain correct — operator dashboards):**
- `src/components/executive/AgentDetailDialog.tsx`, `src/components/financial-ops/WalletDeductionPanel.tsx`, `src/pages/cfo/MoneyFlowTrace.tsx`, `LedgerHealthPanel`, `AnchoredCacheDriftPanel`, `PhantomDriftPanel`, `WalletReconciliationAuditPanel`, `LedgerReconciliationPanel`, `CacheSweepPanel` — operator surfaces that intentionally display the raw cache for reconciliation.

**Cache cleanup path.** When the cache sits above the strict ledger position, the only audited way to reduce it is the **`wallet-cache-sweep`** edge function, surfaced in CFO → Reconciliation → `CacheSweepPanel`. It hard-caps the deduction at `cached − strict` (so it can never touch real customer-owed money), posts a balanced ledger pair under `classification='admin_correction'` / `category='system_balance_correction'` (filtered out of every end-user view), writes `audit_logs` (`action_type='cache_sweep'`, mandatory reason), and emits `wallet.cache_sweep.applied` to `system_events`.
