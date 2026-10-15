# 232 — Allocate errors in the 7-day collection-error export: all four payments landed (2026-10-15)

**Status:** investigation only. No code, migration or data changed.

## What the export showed
`agent-collection-errors-all-7d-20261015-0921.csv`, phase `allocate`, four rows:

| When (UTC) | Error | Tenant / amount | `client_ref` | Outcome in `agent_collections` |
|---|---|---|---|---|
| 10-12 11:21:12 and 11:21:37 | 57014 statement timeout (x2) | Nalubega Penina Pollin, 200,000 | `ec2b0ee8…` | Landed 11:21:54 on the third attempt, one row |
| 10-13 05:37:15 | `Load failed` (iPhone Safari) | Muneza Frank, 16,000 | `49f27c2f…` | Committed 05:37:12, three seconds **before** the error. Response lost, money moved once |
| 10-14 07:03:37 | `Failed to fetch` (Android, 4G 1.5 Mbps) | Bagola Fatima, 30,000 | `cb0db5d5…` | Landed 07:04:39 via same-ref retry, one row |

Each `client_ref` has exactly one `agent_collections` row, so the idempotency design in `AgentTenantCollectDialog` and `agent_allocate_tenant_payment` worked. No double allocation, no lost allocation.

## Why the timeouts are not a code defect (yet)
- `agent_allocate_tenant_payment_internal` already sets `lock_timeout = 3s` and takes the per-agent advisory lock, so lock waits fail fast with 55P03, not 57014.
- `authenticated` has `statement_timeout = 8s`. `pg_stat_statements` for the allocate RPC: 2,441 calls, mean 462 ms, max 4.3 s. `get_user_wallet_view` for the same agent: 16 ms.
- Two timeouts in seven days, both on one request in one 25-second window, point to a transient contention or load spike, not a steady slow path.

## If it recurs
Do not tune blind. Capture `pg_stat_activity` during the event and time `create_ledger_transaction`, `post_rent_fee_collection` and `post_treasury_fee_cash_transfer` separately. Raising the role timeout is not a fix.

## Reading the export
`Failed to fetch` / `Load failed` on allocate do not mean the payment failed. Check `agent_collections` by `client_ref` before telling an agent to repeat it.
