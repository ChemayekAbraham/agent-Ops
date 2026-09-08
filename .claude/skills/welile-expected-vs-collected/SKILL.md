---
name: welile-expected-vs-collected
description: How Welile measures rent collection — `agent_expected_day_plans` (the pinned daily bill) versus `agent_collections` (the receipt book) — and why dividing one total by the other overstates coverage by roughly 2x. Use this whenever anyone asks how much agents collected, what tenants were expected to pay, collection coverage or performance percentages, arrears, shortfalls, partial collections, who missed their target, why two collection figures disagree, or how a collection is recorded; and before writing any SQL, RPC, report, export or dashboard tile that puts "collected" next to "expected".
---

# Expected vs collected: the bill and the receipt book

Two tables carry Welile's rent collection numbers. Their daily totals look
similar, which is exactly why they get divided into each other and produce a
figure roughly twice the truth. They are different populations and neither is
derivable from the other.

| | `agent_expected_day_plans` | `agent_collections` |
| --- | --- | --- |
| A row means | this plan owes this much **on this day** | this agent took this much **at this moment** |
| Key | `(day, rent_request_id)` — one row per plan per day | `id` uuid — one row per payment event |
| Written by | cron, once at 00:05 EAT | `agent_allocate_tenant_payment`, when money moves |
| Exists if nobody pays? | **yes** — that is the whole point | no |
| Two rows for one plan in one day? | no, unique constraint | **yes**, an agent can collect twice |
| Carries money? | no, an obligation | yes, with float before/after |
| Ultimately sourced from | `rent_requests.daily_repayment` via `v_rent_plan_schedule` | the amount the agent typed, gated by float and outstanding |

The bill says what *should* happen; the receipt book says what *did*. They share
one column of meaning, `rent_request_id`, and that is the only honest way to
join them.

## The trap

`SUM(agent_collections.amount) / SUM(agent_expected_day_plans.expected_ugx)` is
wrong, and it is what the Command Center's coverage figure does. Tenants pay off
*older* bills every day, so the numerator contains money the denominator never
billed. On a spot check (2026-09-08, illustration only — always re-derive) the
same day read:

| Reading | Value |
| --- | ---: |
| Expected (pinned bill) | 3,673,184 |
| Total cash in the door | 3,427,483 |
| Naive coverage (cash ÷ bill) | **93%** |
| Collected *against that day's bill* | 1,534,261 |
| True coverage | **41.8%** |
| Arrears collected (older bills) | 1,893,222 |
| Coverage capped per tenant at what they owed | **30.2%** |
| Tenants billed | 194 (50 paid in full, 26 partial, 118 nothing) |

Report four figures instead of one ratio — expected, collected-against-today,
arrears collected, total cash in. Nothing is lost and no one is misled. The SQL
is in `references/queries.md`; use the recipe there rather than rewriting it,
because the `IN (select rent_request_id from bill)` filter is the entire point.

**Capped or uncapped.** Uncapped lets a tenant who overpays cover a tenant who
paid nothing. Capping each tenant at `LEAST(paid, expected)` answers "did today's
tenants meet today's obligation", which is usually what a field-performance
question means. The two differ by a third, so say which basis a figure uses.

**Already fixed — two places, both uncapped.**

- Command Center: `get_agent_collections_coverage(p_start, p_end)` returns
  `expected_due`, `collected_on_schedule`, `collected_arrears`,
  `collected_unattributed`, `coverage_pct` and a per-agent array;
  `AgentCollectionsCommandCenter.tsx` derives coverage and attainment from it.
- Reports: `agent_ops_report_collected(p_from, p_to)` is the companion to
  `agent_ops_report_expected` and splits each agent's cash the same three ways.
  `agent_ops_report_rent_collections` and `agent_ops_report_team_collections`
  score `rate`, the status ladder and the team ranking on
  `collected_on_schedule`, while `collected` still means total cash.

- Comprehensive Report: `get_agent_ops_comprehensive_report` now takes expected
  from the pins (it was on its own `plan_accrual` daily-accrual basis, reading
  ~44% high) and returns `collected_on_schedule` / `collected_arrears` on both
  the window totals and each agent row; `success_rate` and `missed` use the
  on-schedule figure.

Everything else that divides collected by expected is **not** corrected —
`get_agent_products_services_report` (its `expected_cumulative` /
`daily_receivable` basis feeds the agent-ops-v2 Comprehensive Report button),
`PartialCollectionsPanel`, `AgentPerformanceReport`,
`AgentProductsServicesReport`, `AgentRentCapacityPanel` and
`AgentDailyOverviewReportButton`. Check the basis before trusting a percentage
from any of them.

**Attribution mismatch, still open.** `agent_expected_day_plans.agent_id` comes
from `v_rent_plan_schedule`, which is plain `rent_requests.agent_id`. The
comprehensive report credits collections to
`COALESCE(assigned_agent_id, agent_id)`. On a reassigned plan the bill and the
cash can land on different agents. Worth settling before anyone builds incentives
on per-agent attainment.

## How the bill is made, and why once a day is correct

Cron `pin-agent-expected-day-eat-midnight` (`5 21 * * *` UTC = 00:05 EAT) calls
`pin_agent_expected_day(today)`, which inserts one row per plan from
`rent_plan_schedule_days(day, day)` joined to `v_rent_plan_schedule`. It
short-circuits — `if exists (rows for that day) return 0` — so it can never run
twice for a day, and an expectation once pinned never changes.

A plan funded during the day is therefore absent from that day's bill. **That is
correct, not stale: a Rent Plan approved today starts repaying tomorrow**, and
tomorrow's 00:05 pin picks it up. Do not "fix" this, do not propose a 10-minute
re-pin, and do not back-fill days before a plan was funded even when
`v_rent_plan_schedule.term_start` is back-dated.

A consequence worth stating when someone asks why so much cash lands against
plans that were not billed: those back-dated days never entered any bill and
never will, so their repayment always arrives as "arrears". This is expected
behaviour, not a data problem.

Re-deriving expected live from `v_rent_plan_schedule` will read *higher* than the
pin for the same reason. The pin is the reportable number; the live figure is not
"more accurate".

## What a collection row is, and what it is not

An agent collecting rent is **spending their own pre-funded float**. They top up
float, allocating it to the tenant's plan settles that day's rent, and they keep
the tenant's cash. The ledger category says it plainly: `agent_float_used_for_rent`.
Nothing in the system verifies the tenant physically handed over money — the
control is economic, because the agent is out of pocket the instant they record it.

Three movements, three different homes. Only the third is `agent_collections`:

| Movement | Where it lives |
| --- | --- |
| "We paid the landlord" | `rent_requests` + ledger `rent_disbursement` (platform scope) |
| "Now we expect this" | `rent_requests.daily_repayment` → `v_rent_plan_schedule` → `agent_expected_day_plans` |
| "This came back" | `agent_collections` + ledger `agent_float_used_for_rent` |

The CFO's landlord disbursement and the agent's collection float are separate
pots. When someone says "agent_collections tracks what we gave the landlord",
correct it gently: it tracks only the money coming back.

The full write path — every RPC that can create a row, the ledger legs, the
commission split, the guards and the triggers — is in
`references/write-path.md`. Read it before changing anything that writes a
collection, and before explaining to anyone how a row appears.

## Gotchas that have bitten before

- **A reversed collection keeps its `amount`.** `agent_reverse_tenant_allocation`
  only appends `[REVERSED: reason]` to `notes`. Every tile is `SUM(amount)`, so a
  reversal still counts as collected. Filter `notes NOT ILIKE '%[REVERSED:%'` when
  the figure has to be defensible.
- **`collection_channel = 'agent_float'`, `is_partial = false` and
  `performance_weight = 1` are column defaults**, not evidence of anything. Rows
  written by RPCs that never set them still show those values.
- **Ledger legs key on `rent_request_id`, not the collection id**
  (`source_table = 'agent_collections'`, `source_id = p_rent_request_id`), so a leg
  cannot be traced back to one receipt when a plan was collected twice.
- **Inline `expected_amount` on a collection row is not the pinned expectation.**
  It is `agent_expected_collection(rent_request_id)` —
  `GREATEST(0, LEAST(daily_repayment, total_repayment - amount_repaid))` — read
  live at the instant of collection. Summing it is not the day's bill.
- **Timezone.** The bill's `day` is a Kampala date. The overview KPI buckets its
  *range* in UTC while its "today" subtitle uses Kampala, so the two disagree over
  rows between 21:00 and midnight UTC. State which basis a figure uses.
- **The overview collections count has no `amount > 0` filter; the Command
  Center's does.**
- **`repayments`, `field_collections` and `offline_collection_submissions` are
  effectively dormant** — check them before claiming `agent_collections` is the
  whole picture, but expect zeros. `tenant_self_repayment_attempts` fills up daily
  with `outcome = 'refused'`; those are not collections.

## Answering a question about collections

1. Establish which question is being asked — "how much money came in" (receipt
   book alone) or "are agents keeping up" (both tables, joined). They have
   different answers and people rarely say which they mean.
2. Query the database rather than a cached figure. `get_agent_ops_overview` and
   `get_agent_collections_command_center` raise `auth_required` without a user JWT,
   so replicate them in plain SQL — see `references/queries.md` for connection
   details and ready recipes.
3. Say what basis each number uses (Kampala date, pinned vs live, capped vs
   uncapped) and the as-at time. Collections arrive continuously; a figure quoted
   without a timestamp is wrong within minutes.
4. Never quote a number from this file or any prior session as current. Every
   figure here is an illustration of shape, not a baseline.

Related: the `agent-identification` skill covers how agents and sub-agents are
counted and why the Overview and the daily report disagree on totals.
