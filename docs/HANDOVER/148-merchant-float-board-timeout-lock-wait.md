# 148 — "Money with merchant agents" board timed out behind background jobs

**Date:** 2026-09-28 · **Reported by:** Josh (screenshot: "This board could not load: canceling statement due to statement timeout", UGX 0 on all three figures)
**Migration:** `supabase/migrations/20260928200000_merchant_float_board_refresh_never_waits_on_locks.sql`
**Status:** LIVE 2026-09-28. Applied through `query_database` and verified: the new body is live, and the board returns 17 desks in 3.4 s when run as a finance login, with `lock_timeout` restored afterwards.

## Cause

`get_merchant_float_positions()` feeds `MoneyWithAgentsCard` (Financial Ops). Before reading, it refreshes every active desk whose `wallet_balances_projection` is older than its latest wallet leg (`refresh_wallet_projection_for`). That refresh **writes** the projection row, so it waits on row locks.

At 13:18–13:21 UTC these ran at the same time:

| Job (start, UTC) | Duration |
|---|---|
| `refresh-wallet-totals-cache` 13:18:00 | 34.8 s |
| `reconcile-evidenced-withdrawal-settlements` 13:20:00 | 14.6 s |
| `refresh-wallet-totals-cache` 13:21:00 | 22.9 s |

The board's refresh queued behind them and hit the `authenticated` role's `statement_timeout = 8s`.

The query itself is not slow:

| Part | Time |
|---|---|
| The whole function, unblocked | 2.9–3.7 s |
| Out-of-pocket `merchant_float_position_at` check (460 pending claims) | 1.4 s (the largest part) |
| Every other CTE | < 0.05 s each |
| All 17 projection refreshes together | 0.14 s |

**The UGX 0 figures were "did not load", not real balances.**

## Fix

Only the refresh loop changed. The report query (`RETURN QUERY …`) is **byte-identical** to the previous live body, which was verified by MD5 against production before applying.
- `lock_timeout = 250ms` applies to the refresh loop only, and the previous value is restored after it.
- Each desk refresh runs in its own subtransaction. If a desk's row is locked (`lock_not_available`), the refresh is skipped and the stored projection is shown, which the existing `is_stale` and `stale_since` columns already flag.

This is a read-only report and no money path changed. The function is not in `critical_function_baselines`.

## Still worth doing

`refresh-wallet-totals-cache` runs every 3 minutes and took 23–35 s here. It is the main source of lock pressure (see doc 142's CTO triage).

## Also in this commit

The consent migration from doc 143 was renamed `20260928180000` → `20260928181000`. Upstream now also has a `20260928180000_*` migration, and Supabase keys migrations by timestamp. The consent migration was already applied by hand, so this only renames the file.
