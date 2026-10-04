# 20. Fix — CTO report hardcoded slow-query recurrence data (2026-09-14)

**Status: fixed, verified live.** Prompted by a user noticing "that function has been generating
the same report for a long time now" — a correct observation, traced to its actual cause rather
than dismissed as expected behaviour.

---

## The one-sentence cause

`daily-cto-report/index.ts`'s slow-query issue builder hardcoded, for **every** slow-statement
issue, **every single day, forever**:

```ts
status: 'Open', isNew: false, isRecurring: true, daysActive: 30, previouslyFixed: false,
timeline: 'Cumulative since the last statistics reset.'
```

Literal constants. Not derived from any real data. The report read identically for these issues
regardless of whether they actually started yesterday or months ago — which is exactly what "the
same report every day" meant.

## Why it looked like a reasonable design at the time

A comment already sitting on this code block explains the original reasoning: `pg_stat_statements`
is a lifetime-cumulative counter with no daily reset, so a prior engineer had already (correctly)
made sure severity/priority/blocking-production status came from `get_cto_issue_intelligence`'s
own classification rather than being re-derived from `mean_ms` alone client-side. What was missed:
`pg_stat_statements` **has** carried a real per-statement `stats_since` column since PG14 — it was
simply never selected, so `daysActive` etc. fell back to a flat placeholder instead of a real
figure.

## The fix

1. Added `stats_since` to `get_cto_issue_intelligence`'s `slow_queries` payload (one line).
2. In `daily-cto-report/index.ts`, replaced the hardcoded `daysActive`/`isNew`/`isRecurring`/
   `timeline` with values computed from it: `daysActive = floor((now - stats_since) / 1 day)`,
   `isNew = daysActive < 2`, `isRecurring = daysActive >= 2`, and a `timeline` string naming the
   actual first-seen date.

`previouslyFixed` was deliberately left `false` rather than computed — there is no reliable "was
this fixed and regressed" signal available for a lifetime-cumulative counter, and fabricating one
would just be a different flavour of the same problem this fix addresses. Left as an honest
unknown.

---

## What this actually revealed once fixed

The ten slow queries in the report have genuinely wildly different ages — nothing close to a flat
30 days:

| Query | Real days active |
|---|---|
| `realtime.list_changes(...)` (wal type/schema/table select) | **214** |
| pgrst_source (get_user_wallet_view RPC wrapper) | 208 |
| pgrst_source (`profiles` referrer lookup) | 206 |
| pgrst_source (get_user_wallet_view, second query-plan generation) | 135 |
| `reconcile_wallets_batch($1, $2)` | 130 |
| `realtime.list_changes` (second generation) | 102 |
| pgrst_source (`landlords` lookup) | 90 |
| `auto_create_deposits_from_gmail($1)` | 75 |
| `refresh_wallet_totals_cache()` | 62 |
| `reconcile_evidenced_withdrawal_settlements()` | 32 |

Several of these have been chronically slow **since February** — far more urgent-looking, and far
more informative for prioritisation, than a flat "30 days" ever communicated.

---

## Verify this is still working

```sql
-- stats_since flows through correctly:
select jsonb_pretty(v.slow_query) from (
  select jsonb_array_elements(get_cto_issue_intelligence()->'slow_queries') as slow_query
) v limit 1;
-- expect a "stats_since" key with a real timestamp

-- independent cross-check of the day-count math:
select left(v.slow_query->>'statement', 50),
       floor(extract(epoch from now() - (v.slow_query->>'stats_since')::timestamptz) / 86400)::int
from (select jsonb_array_elements(get_cto_issue_intelligence()->'slow_queries') as slow_query) v
order by 2 desc;
```

If `stats_since` is ever missing from a row (extension reset, PG downgrade), the edge function
falls back to the old flat `daysActive: 30` / `isRecurring: true` — check for that fallback firing
silently before assuming the numbers are real again.

---

## What not to do

- Don't assume a report section reading identically day after day is "just how this metric works."
  It was one specific finding away from being a real, fixable data-accuracy bug — the difference
  between 32 and 214 days matters for prioritisation and wasn't being captured at all.
- Don't extend this pattern (deriving age from a lifetime-cumulative source) to `previouslyFixed`
  or similar without a real per-issue history table backing it. A plausible-looking derived value
  is not better than an honest "unknown" if it isn't actually traceable to real data.
