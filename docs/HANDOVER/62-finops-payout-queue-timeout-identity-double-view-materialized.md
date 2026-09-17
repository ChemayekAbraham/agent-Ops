# 62 — 2026-09-17: `finops_payout_verification_queue` timed out again — `v_identity_double_users` was the real bottleneck

**Fixed and applied live to production** (`supabase/migrations/20260917150000_materialize_identity_double_users_for_finops_queue.sql`),
2 days after doc 28 / the Sept 15 index fix addressed a *different* bottleneck in the same RPC.

## The report

Josh, pasting a FinOps UI error:

```
FINANCIAL OPS  Request: database function · finops_payout_verification_queue
Error code: 57014 — canceling statement due to statement timeout
Attempted at: 2026-09-17T12:00:54.758Z (8616 ms)
Filters: {"p_status":"waiting","p_search":null,"p_sort":"newest","p_limit":20,"p_offset":0,...}
```

This is the same RPC and error code the Sept 15 fix (`20260915160000_index_national_id_normalized_lookup.sql`)
targeted. First checked whether that fix actually shipped — it did (`idx_profiles_national_id_normalized_a/b`
and the `payout_destination_verifications` equivalent all exist live). So this is a **second, separate**
timeout cause, not a regression of the first fix.

## Root cause

`public.v_identity_double_users` is a plain (non-materialized) view used to flag duplicate-identity
payout requests. It does a full duplicate-detection sweep **over all of `public.profiles`
(96,651 rows)** from scratch on every single call:

- 4 separate `WINDOW` passes (national-ID fuzzy match, face-hash, ID-photo-hash, phone-last-9),
  each sorting/partitioning the entire table
- a correlated self-join (`nid_verified`) for the national-ID-vs-already-verified-user branch

Both FinOps RPCs `LEFT JOIN` this view:
- `finops_payout_verification_queue` — and its own `counted` CTE forces a full, un-paginated
  evaluation of `base` (hence the view) regardless of `p_limit`
- `finops_payout_verification_counts` — the summary-tile RPC, which almost certainly fires
  alongside the queue on the same page load

Measured live via `EXPLAIN (ANALYZE, BUFFERS)` against production:

```
Aggregate  (actual time=2826.192..2826.213 rows=1 loops=1)     -- counted CTE, p_status='waiting'
  ...
  CTE p
    ->  Seq Scan on profiles (actual time=9.312..2119.240 rows=96651)   -- the whole view's cost
```

~2.1–2.8s **just for this view**, before either RPC does anything else — most of the
`authenticated` role's 8s `statement_timeout` (`SELECT rolconfig FROM pg_roles WHERE rolname =
'authenticated'` → `statement_timeout=8s`), consumed by one join that has nothing to do with
`p_limit`, `p_search`, or any of the RPC's actual filters. This is a scaling problem, not a missing
index — the Sept 15 indexes don't touch it because there's no equality lookup to index here, it's
CPU-bound work (regexp/translate over every row) repeated on every call.

## The fix

Materialized the view and refresh it on a cron, same pattern already used elsewhere in this repo
(`mv_house_location_rollup`, `mv_ops_daily_summary`, wallet totals cache):

- `public.mv_identity_double_users` — `CREATE MATERIALIZED VIEW ... AS SELECT * FROM
  public.v_identity_double_users`, plus a unique index on `user_id` (required for `CONCURRENTLY`
  refresh, and to keep the join a cheap index/seq scan instead of a full-table scan on every FinOps
  call)
- `public.refresh_mv_identity_double_users()` — `SECURITY DEFINER` wrapper around `REFRESH
  MATERIALIZED VIEW CONCURRENTLY`
- `refresh-identity-double-users-5m` — new `pg_cron` job, every 5 minutes
- `finops_payout_verification_queue` and `finops_payout_verification_counts` repointed from
  `v_identity_double_users` to `mv_identity_double_users`. Bodies are otherwise byte-identical
  (confirmed against live `pg_get_functiondef` before editing) — only the join target changed.

The underlying `v_identity_double_users` view itself was left alone (nothing else depends on it —
checked `pg_depend`), so anything that needs a live, zero-staleness read of it still can.

**Trade-off accepted:** duplicate-identity flags on the payout queue can now be up to 5 minutes
stale. Acceptable — these are manual-review flags for FinOps staff deciding whether to call
someone, not a real-time payout gate.

**Verified fixed:** re-ran the exact `counted` CTE (the expensive half) with the materialized join —
**11.8ms**, down from 2837ms (~240×). Row counts between the live view and the materialized view
matched (3 and 3) immediately after creation. Applied directly to production via `query_database`
with Josh's explicit go-ahead (initial DDL attempt was auto-blocked as a shared-resource action;
re-ran after confirmation).

## Not done

- Did not add a matching materialized cache for `v_identity_double_users` consumers outside these
  two RPCs, because there are none today (`pg_depend` / `prosrc ILIKE` search came back clean) —
  if a third consumer shows up later, point it at `mv_identity_double_users` too rather than the
  live view.
- Did not attempt to speed up the view's own internal window-function/self-join logic (e.g.
  narrowing the base CTE to only rows with a non-null nid/face/idimg/phone up front) — materializing
  it made that unnecessary for now, but if 5-minute staleness ever becomes a problem, that's the
  next place to look before reaching for a shorter cron interval.
