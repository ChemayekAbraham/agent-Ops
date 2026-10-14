# Food System — two-session concurrency acceptance tests

These prove the things a single session **cannot**: that two overlapping
transactions actually block each other. Everything here needs two genuinely
independent psql connections.

> **Run this only against a disposable database.**
> Unlike the other scripts in `supabase/tests/`, this suite is **not**
> rollback-only. Session A has to COMMIT for Session B to observe its effect,
> which is the whole point. It also cannot fully delete after itself: the food
> schema makes `food_orders`, `food_meals`, `food_order_events` and `food_audit`
> append-only with no-delete triggers, and `99_cleanup.sql` does **not** weaken
> those controls to tidy up. Cleanup cancels and archives its own fixtures
> instead, and every statement is scoped to the run tag below.

Everything this suite creates carries the tag `CONCURRENCY-TEST` or sits in the
reserved uuid range `f0000000-0000-4000-8000-%`. Nothing else is touched.

## What is verified, and what is not

At the time of writing, **cross-session blocking has never been executed** —
the tooling available to the author serializes database calls, so the live
result is **UNVERIFIED**. The lock itself was confirmed present and correctly
keyed via `pg_locks` within a single transaction; that is not the same thing.
These scripts exist so an engineer with psql access can close that gap.

## How to run

Two terminals, both pointed at the **disposable** database.

```bash
# once, in either terminal
psql "$DISPOSABLE_URL" -v ON_ERROR_STOP=1 -f 00_setup.sql
```

### Scenario 1 — per-employee order cap (the fix under test)

```bash
# terminal 1 — starts first, holds its transaction ~8s
psql "$DISPOSABLE_URL" -v ON_ERROR_STOP=1 -f 10_cap_a.sql

# terminal 2 — start within ~2s of terminal 1
psql "$DISPOSABLE_URL" -v ON_ERROR_STOP=1 -f 11_cap_b.sql
```

Start terminal 2 while terminal 1 is still running. `11_cap_b.sql` records how
long it waited; that wait is the evidence.

### Scenario 2 — stock reservation

```bash
psql "$DISPOSABLE_URL" -f 20_stock_a.sql     # terminal 1
psql "$DISPOSABLE_URL" -f 21_stock_b.sql     # terminal 2, within ~2s
```

### Scenario 3 — exception resolution

```bash
psql "$DISPOSABLE_URL" -f 30_exception_a.sql # terminal 1
psql "$DISPOSABLE_URL" -f 31_exception_b.sql # terminal 2, within ~2s
```

### Then

```bash
psql "$DISPOSABLE_URL" -v ON_ERROR_STOP=1 -f 90_verify.sql   # assertions
psql "$DISPOSABLE_URL" -v ON_ERROR_STOP=1 -f 99_cleanup.sql  # scoped teardown
```

## Expected results

| Scenario | Session A | Session B | The evidence |
|---|---|---|---|
| 1 — order cap | places 1 of a cap of 2, holds, commits | **blocks ~6s**, then rejected: `You can order at most 2 item(s)…` | B's `waited_seconds` ≈ A's hold. Near-zero means it never blocked — the fix is not working |
| 2 — stock | reserves the last serving, holds, commits | blocks, then rejected: `Not enough servings left` | `servings_reserved ≤ servings_total` always |
| 3 — exception | resolves it, holds, commits | blocks, then rejected: `already resolved` | exactly one audit row; A's reason survives |

`90_verify.sql` fails loudly if any of this does not hold. A `waited_seconds`
under ~1s on scenario 1 means **the cap race is still open** — report it rather
than re-running until it passes.

## Why the timing is loose

Coordination is by wall clock: A holds for 8s, B starts ~2s in. That is crude
but honest — there is no cross-session barrier available without extensions.
The margin is wide enough that ordinary scheduling jitter cannot produce a
false pass, and `90_verify.sql` checks the *outcome*, not just the timing.
