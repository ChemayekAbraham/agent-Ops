# Reversed collections, and the 26 plan balances that still hold them

Measured 2026-09-29 against production, from the two CTO health checks at
`/cto/dashboard?section=monitor-agent-collections`.

## The one fact that shaped everything

A reversed collection **keeps its amount** in `agent_collections`; only
`reversed_at` is stamped. So the question was never "is the data wrong" — it is
"which surfaces forgot to filter".

Whole table:

| How the reversal is marked | Collections | Amount |
|---|---:|---:|
| `reversed_at` **and** a `[REVERSED:` note | 1,226 | 98,947,719 |
| `reversed_at` only | 48 | 1,417,000 |
| **A `[REVERSED:` note only** | **0** | **0** |
| **Total reversed** | **1,274** | **100,364,719** |

Every reversal sets `reversed_at`. So `reversed_at IS NULL` is a **complete**
filter, and the ~90 reporting functions already using it were correct all
along. That collapsed the job from "130 objects mention agent_collections" to
seven that sum money with no filter at all.

## What was actually wrong, and what was left alone

| Object | Sums money? | Verdict |
|---|---|---|
| `v_agent_collection_performance` | yes | **fixed** — summed every row |
| `v_rent_repaid_reconciliation` | yes | **fixed** — the judging instrument was itself blind |
| `v_agent_daily_eligibility` | activity test | **fixed** — a reversed collection held finished plans open |
| `get_agent_guarantor_float_preview` | counts + dates | **fixed** — inflated pay counts, closed gaps that never closed |
| `agent_collections_monitor` | the check itself | **fixed** — 6 false positives |
| `process_verified_field_deposit` | yes | left alone — collections engine |
| `settle_tenant_rent_from_deposit` | yes | left alone — collections engine |
| `tops_allocate_collection` | yes | left alone — collections engine |
| `rent_apply_collections_to_days` | yes | **left alone, but flawed** — see below |

### Surfaces that were already correct

The two named as suspect turned out to be clean:

- **Team collections** (`agent_ops_report_team_collections`) draws its money
  from `agent_ops_report_collected`, which filters `reversed_at IS NULL`.
- **Service centre** (`get_service_center_tenant_payments`) selects from
  `(SELECT * FROM agent_collections WHERE reversed_at IS NULL)`.

Neither needed changing. If their figures still look wrong, the cause is the
plan balance below, not a missing reversal filter.

### The one still outstanding

`rent_apply_collections_to_days` filters on the `[REVERSED:` **note** only, so
it misses the 48 collections marked by column alone — **UGX 1,417,000**. It
attributes collections to days, which makes it engine rather than reporting, so
it was not touched under the "do not affect the collections engine" constraint.
It should be brought onto `reversed_at` deliberately, with day attribution
re-run and checked.

## Two facts worth keeping

**`repayments.amount` can be negative.** 49 rows, **-1,717,000**, across 44
plans — reversals are booked there as negative entries. So
`v_rent_repaid_reconciliation.ledger_total` is a **net** figure, not gross. One
plan reads `ledger_total = -110,000`. Any check comparing a balance against it
is asking "is this above net receipts", not "does this hold reversed money".
Switching the monitor onto it pushed the count from 32 up to 50 and was
reverted for that reason.

**`amount_repaid` cannot be reconstructed.** Of the 32 plans originally
flagged, only 1 satisfies `amount_repaid = live collections + repayments`.
Adding every source still does not explain the rest.

## The 26 plans — for a person to decide

After removing the 6 false positives, **26 plans carry UGX 10,763,668** of
reversed money in `amount_repaid`.

| Agent | Plans | Exposure | Repaid | Live collected | Unbacked by ledger | Balance edits |
|---|---:|---:|---:|---:|---:|---:|
| JAMES KATONGOLE | 3 | 5,508,668 | 6,872,223 | 402,700 | 6,469,523 | 41 |
| OACAR ARNOLD | 2 | 2,025,000 | 4,733,506 | 2,708,506 | 2,050,000 | 12 |
| Thomas hawahka | 6 | 1,133,000 | 3,875,500 | 2,742,500 | 1,207,000 | 58 |
| Denis Tushabe | 6 | 1,040,000 | 3,060,000 | 1,474,000 | 1,460,000 | 47 |
| IAN MUHWEZI | 3 | 400,000 | 14,690,288 | 5,150,288 | 9,940,000 | 33 |
| Nsamba Ivan | 1 | 299,000 | 455,347 | 156,347 | 299,000 | 37 |
| WAMBULA AVIN | 3 | 258,000 | 554,000 | 237,000 | 258,000 | 17 |
| KENNETH SEKABEMBE | 2 | 100,000 | 705,900 | 115,900 | 550,000 | 30 |

**JAMES KATONGOLE is the one to look at first**: 3 plans, UGX 6,872,223 of
recorded balance against **402,700** actually collected — 41 manual balance
edits. More than half the whole exposure sits there.

**IAN MUHWEZI is a different shape**: only 400,000 of reversal exposure, but
**9,940,000 unbacked by any ledger** across 3 plans. The reversals are almost
incidental; the balance is the problem.

### Why these were not corrected automatically

Every one is `traced_no_ledger`: the balance was set by manual edits recorded in
`rent_amount_change_log`, not by collections. Setting `amount_repaid` to live
collections would remove **UGX 22,233,523** in total — and since
`amount_repaid` is what a tenant has paid off, **that raises their outstanding
debt by the same amount**.

Correcting a reporting figure is one thing. Adding 22 million to what real
tenants owe, on the strength of an inference, is another. The instruction was
to balance the books without touching the collections engine, and a balance
rewrite of this size is exactly the thing that constraint rules out.

### The order to work them in

1. **Read the balance edits** for JAMES KATONGOLE's 3 plans in
   `rent_amount_change_log` — who made them, when and why. 41 edits against
   402,700 collected needs an explanation before anything is changed.
2. **Decide the rule per shape**, not per plan: a balance credited in error
   comes down; a balance credited for money that arrived off-platform stays and
   gets a ledger leg posted for it.
3. **Whatever the rule, apply it as a reversible migration** with audit rows,
   the way the first 25 plans were handled on 2026-09-28.

## Re-running the numbers

```sql
-- the two checks, as the CTO dashboard shows them
SELECT check_key, hits, exposure_ugx
  FROM public.agent_collections_monitor(180)
 WHERE check_key IN ('reversed_still_counted', 'plan_balance_holds_reversed');
```

`reversed_still_counted` is an **exposure** figure, not a defect count: it is
how much a SUM would overstate if someone forgot the filter. It does not fall
when surfaces are fixed, and it should not. `plan_balance_holds_reversed` is
the one that should fall as the 26 are worked through.
