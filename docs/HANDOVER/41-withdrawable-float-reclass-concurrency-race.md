# 41 — Withdrawable↔float bucket-reclass concurrency race (fix written, not yet deployed)

**Migration written and committed but not yet applied to production — read this before
assuming `create_ledger_transaction_locked` exists live, or before touching
`agent-convert-withdrawable-to-float`, `admin-withdrawable-to-float`, or
`postBalancedLedgerGroup`.**

## What was found

Asked to assess the safety of the agent dashboard's "Move balance to Float" self-service
button (`AgentConvertToFloatCard.tsx` → `agent-convert-withdrawable-to-float`). It does post a
genuine balanced double-entry group — `postBalancedLedgerGroup` prices both legs against
`ledger_account_map` and requires debits == credits before writing anything, then re-prices
the written rows as a drift check. That part is solid and matches Financial Ops' own
`admin-withdrawable-to-float` implementation exactly.

The gap: both functions pass `skipBalanceCheck: true` to `postBalancedLedgerGroup` (the
in-function comment says the engine's single-bucket pre-check "can't judge" a cross-bucket
move), and rely entirely on an earlier, separate `get_user_available_balance()` read done
before posting. Under READ COMMITTED, two concurrent conversions for the same user — two
devices, a client-side retry, a proxy caller — can both read the same pre-move balance, both
pass, and both post, overdrawing withdrawable. No idempotency key is passed either, so
`create_ledger_transaction`'s own advisory-lock-on-`idempotency_key` mechanism never engages
for this path.

Went looking for the DB-level backstop and found one already exists —
`enforce_no_negative_wallet_ledger`, an unconditional `BEFORE INSERT` trigger on
`general_ledger`, re-checks `get_user_available_balance()` for any withdrawable cash_out
regardless of `skip_balance_check`. But it takes **no row lock either**, so it has the
identical race window. A prior attempt at a real fix
(`20260811062541_wallet_row_locking_race_fix.sql`, a per-user row lock gated behind
`wallet_row_locking_rollout` / `wallet_row_locking_canary_users`, staged as internal → low-volume
→ agents) **was never applied to production** — confirmed live: `wallet_row_locking_applies`
and both rollout tables don't exist in the production catalog at all, despite being in the
migrations folder. `admin-withdrawable-to-float` already has an after-the-fact detective
control for this (reads the bucket back post-write and logs to `wallet_overdraw_events` if
negative) — a sign the original author knew the risk but only shipped detection, not
prevention.

## What was fixed

`20260916180000_create_ledger_transaction_locked_bucket_reclass.sql` adds
`create_ledger_transaction_locked(entries, idempotency_key, skip_balance_check, lock_user_id,
min_available)`: takes `pg_advisory_xact_lock(hashtext('bucket_reclass:' || lock_user_id))`,
re-reads `get_user_available_balance(lock_user_id)` under that lock, raises
`INSUFFICIENT_BALANCE` if it's short, and otherwise delegates unchanged to the existing
`create_ledger_transaction`. The lock is scoped to the `bucket_reclass:` salt specifically so
it never contends with unrelated ledger writes for the same user (deposits, withdrawals,
tenant payments) — only with other bucket-reclass calls.

`postBalancedLedgerGroup` (`supabase/functions/_shared/balancedLedgerPost.ts`) gained two new
options, `lockUserId` and `minAvailable`; when `lockUserId` is set it posts through
`create_ledger_transaction_locked` instead of `create_ledger_transaction`. Both
`agent-convert-withdrawable-to-float` and `admin-withdrawable-to-float`'s main reclass call now
pass `lockUserId` (the account being debited) and `minAvailable` (the amount). Every other
existing caller of `postBalancedLedgerGroup`/`create_ledger_transaction` is untouched — the new
option is additive and defaults to the old, unlocked behavior.

## What was deliberately left alone

- **`admin-float-to-withdrawable`** (the reverse direction of the same feature) and
  **`finops-wallet-move`** have the identical `skipBalanceCheck: true`, no-idempotency-key
  pattern, debiting float instead of withdrawable. Not fixed here — out of the scope that was
  asked for (this pass covers "Move balance to Float" and its Financial Ops counterpart only).
  `create_ledger_transaction_locked`'s `min_available` check is withdrawable-specific
  (`get_user_available_balance`); wiring it to float would need a float-balance equivalent
  first. Worth doing as a follow-up — same bug, same fix shape.
- **The never-shipped `wallet_row_locking_rollout` system** was not resurrected or completed.
  It was deliberately staged behind a feature flag because system-wide per-user row locking on
  every ledger write risks deadlocks/timeouts; reviving it properly (and actually rolling out
  the canary) is a much bigger, riskier change than this narrowly-scoped advisory lock.
- The overdraft-fill leg inside `admin-withdrawable-to-float` (the `system_balance_correction`
  that zeroes a float overdraft before the real reclass) is not locked — it's an admin-only,
  low-frequency correction path with much lower concurrency exposure than the self-service
  button.

## Verify this is deployed and working

```sql
-- Should exist once the migration is applied (it did not exist as of 2026-09-16):
select proname from pg_proc where proname = 'create_ledger_transaction_locked';
```

Functional check: fire two concurrent `agent-convert-withdrawable-to-float` calls for the same
agent with an amount that individually fits but jointly exceeds available balance — exactly one
should succeed, the other should get `INSUFFICIENT_BALANCE`.

## What not to do

- Don't add `idempotency_key` values that are regenerated per HTTP call (e.g. a fresh
  `crypto.randomUUID()` per request, as both functions already do for `reference_id`) and
  assume that closes this race — it doesn't. `create_ledger_transaction`'s idempotency lock
  only dedupes a literal replay of the *same* key; two different requests still race unless
  something locks on the *user*, not the request.
- Don't assume this migration is live just because it's committed — check the query above
  first, the same way doc 34 and doc 36's migrations sat committed-but-undeployed for a while.
