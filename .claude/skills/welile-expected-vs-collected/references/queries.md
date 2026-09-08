# Query recipes

## Contents

- [Getting a connection](#getting-a-connection)
- [1. The four figures for a day](#1-the-four-figures-for-a-day)
- [2. Capped coverage and the paid / partial / nothing split](#2-capped-coverage-and-the-paid--partial--nothing-split)
- [3. Cash in the door (receipt book alone)](#3-cash-in-the-door-receipt-book-alone)
- [4. Per-agent performance for a day](#4-per-agent-performance-for-a-day)
- [5. Tenants billed but not collected from](#5-tenants-billed-but-not-collected-from)
- [6. Was the day actually pinned?](#6-was-the-day-actually-pinned)
- [7. Confirming no other channel is live](#7-confirming-no-other-channel-is-live)
- [8. Defensible totals (excluding reversals)](#8-defensible-totals-excluding-reversals)

## Getting a connection

The dashboard RPCs (`get_agent_ops_overview`, `get_agent_collections_command_center`)
call `auth.uid()` and raise `auth_required` without a user JWT, so a plain SQL
connection cannot execute them. Replicate them in SQL instead.

The Lovable MCP connector reaches the production Postgres directly:

- tool: `query_database`
- project: `welilereceipts-com`, id `43e6c2e1-18a6-4503-badb-5bb6c23491cc`
- workspace: `Welile's Lovable` (`ZvxyWdFk8iGNRBgJKysM`)

Prefer `SELECT`. These are live production tables carrying real money.

Every recipe below uses the Kampala calendar day, which is what
`agent_expected_day_plans.day` means. Swap `(now() at time zone 'Africa/Kampala')::date`
for a literal date to run them for a past day.

## 1. The four figures for a day

The core recipe. Report all four rather than a single coverage ratio.

```sql
with d as (select (now() at time zone 'Africa/Kampala')::date as day),
bill as (
  select ep.rent_request_id, ep.expected_ugx
  from agent_expected_day_plans ep cross join d
  where ep.day = d.day
),
cash as (
  select ac.rent_request_id, ac.amount
  from agent_collections ac cross join d
  where (ac.created_at at time zone 'Africa/Kampala')::date = d.day
)
select
  (select sum(expected_ugx) from bill)                                as expected_today,
  (select coalesce(sum(amount),0) from cash
     where rent_request_id in (select rent_request_id from bill))     as collected_against_today,
  (select coalesce(sum(amount),0) from cash
     where rent_request_id not in (select rent_request_id from bill)) as arrears_collected,
  (select coalesce(sum(amount),0) from cash)                          as total_cash_in,
  round(100.0 * (select coalesce(sum(amount),0) from cash
     where rent_request_id in (select rent_request_id from bill))
      / nullif((select sum(expected_ugx) from bill),0), 1)            as coverage_pct;
```

`collected_against_today ÷ expected_today` is coverage. `total_cash_in ÷
expected_today` is the inflated reading; quote it only alongside the arrears
line that explains it.

The same split ships as an RPC for any window —
`get_agent_collections_coverage(p_start timestamptz, p_end timestamptz)` —
returning `expected_due`, `collected_total`, `collected_on_schedule`,
`collected_arrears`, `collected_unattributed`, `coverage_pct` and a per-agent
array. It is role-gated like the Command Center (manager / super_admin / ceo /
coo / cfo / operations / agent_ops), so it needs a user JWT; from a plain SQL
connection run the recipe above instead. Across a multi-day window it treats a
payment as on-schedule when the plan was billed on **any** elapsed day in that
window rather than day-for-day — a tenant billed Monday who pays Wednesday has
still paid a bill the window owns.

## 2. Capped coverage and the paid / partial / nothing split

Caps each tenant at what they owed, so an overpayment cannot mask a tenant who
paid nothing. This is usually the right basis for judging field performance.

```sql
with d as (select (now() at time zone 'Africa/Kampala')::date as day),
bill as (select ep.rent_request_id, ep.expected_ugx
         from agent_expected_day_plans ep cross join d where ep.day = d.day),
paid as (select ac.rent_request_id, sum(ac.amount) amt
         from agent_collections ac cross join d
         where (ac.created_at at time zone 'Africa/Kampala')::date = d.day
         group by 1)
select sum(b.expected_ugx)                                              as expected,
       sum(least(coalesce(p.amt,0), b.expected_ugx))                    as collected_capped,
       round(100.0 * sum(least(coalesce(p.amt,0), b.expected_ugx))
             / nullif(sum(b.expected_ugx),0), 1)                        as coverage_capped_pct,
       count(*) filter (where coalesce(p.amt,0) >= b.expected_ugx)      as tenants_fully_paid,
       count(*) filter (where coalesce(p.amt,0) > 0
                          and p.amt < b.expected_ugx)                   as tenants_partial,
       count(*) filter (where coalesce(p.amt,0) = 0)                    as tenants_nothing
from bill b left join paid p on p.rent_request_id = b.rent_request_id;
```

## 3. Cash in the door (receipt book alone)

For "how much did agents collect today" with no performance judgement attached.

```sql
select count(*)                                        as collections,
       coalesce(sum(amount),0)                         as total_collected,
       count(distinct agent_id)                        as agents,
       count(distinct tenant_id)                       as tenants,
       min(created_at at time zone 'Africa/Kampala')   as first_collection,
       max(created_at at time zone 'Africa/Kampala')   as last_collection
from agent_collections
where (created_at at time zone 'Africa/Kampala')::date
    = (now() at time zone 'Africa/Kampala')::date;
```

Group by `(created_at at time zone 'Africa/Kampala')::date` for a trend. Join
`profiles` on `agent_id` for names — it contributes no money.

## 4. Per-agent performance for a day

Agents appear on the bill via `agent_expected_day_plans.agent_id`, and in the
receipt book via `agent_collections.agent_id`. Those can differ: a plan can be
collected by an agent other than the one it was pinned to.

Aggregate each side first, then full-join the aggregates. Joining the raw rows
instead fans out and inflates both columns.

```sql
with d as (select (now() at time zone 'Africa/Kampala')::date as day),
bill as (select ep.agent_id, sum(ep.expected_ugx) expected, count(*) tenants_billed
         from agent_expected_day_plans ep cross join d
         where ep.day = d.day group by 1),
cash as (select ac.agent_id, sum(ac.amount) collected, count(*) collections
         from agent_collections ac cross join d
         where (ac.created_at at time zone 'Africa/Kampala')::date = d.day group by 1)
select coalesce(b.agent_id, c.agent_id) as agent_id,
       coalesce(p.full_name, p.phone)   as agent,
       coalesce(b.expected,0)           as expected,
       coalesce(b.tenants_billed,0)     as tenants_billed,
       coalesce(c.collected,0)          as collected,
       coalesce(c.collections,0)        as collections
from bill b
full join cash c on c.agent_id = b.agent_id
left join profiles p on p.id = coalesce(b.agent_id, c.agent_id)
order by collected desc;
```

`collected` here includes arrears, so an agent can far exceed their own expected
without a single tenant paying on time. A real row from 2026-09-08: expected
361,768 across 4 billed tenants, collected 1,030,000 across 9 collections —
285%, almost entirely old debt. Never present this column as attainment without
saying so; use recipe 2 if the question is "did today's tenants pay".

## 5. Tenants billed but not collected from

The follow-up question after any coverage figure: who was missed.

```sql
with d as (select (now() at time zone 'Africa/Kampala')::date as day)
select ep.agent_id, ep.tenant_id, ep.rent_request_id, ep.expected_ugx
from agent_expected_day_plans ep cross join d
where ep.day = d.day
  and not exists (
    select 1 from agent_collections ac
    where ac.rent_request_id = ep.rent_request_id
      and (ac.created_at at time zone 'Africa/Kampala')::date = d.day)
order by ep.expected_ugx desc;
```

## 6. Was the day actually pinned?

If a day has no rows the cron did not run, and every coverage figure for that
day is meaningless rather than zero.

```sql
select day, count(*) rows, sum(expected_ugx) expected,
       min(captured_at) first_pin, max(captured_at) last_pin
from agent_expected_day_plans
where day >= (now() at time zone 'Africa/Kampala')::date - 7
group by 1 order by 1 desc;
```

`first_pin = last_pin` and a single timestamp near 21:05 UTC is healthy. The
cron itself:

```sql
select jobid, jobname, schedule, active, command from cron.job
where jobname = 'pin-agent-expected-day-eat-midnight';
```

## 7. Confirming no other channel is live

Before asserting `agent_collections` is the whole picture:

```sql
select 'repayments' t, count(*) n from repayments
  where created_at > now() - interval '30 days'
union all select 'field_collections', count(*) from field_collections
  where created_at > now() - interval '30 days'
union all select 'offline_collection_submissions', count(*) from offline_collection_submissions
  where created_at > now() - interval '30 days';
```

`tenant_self_repayment_attempts` accumulates dozens of rows a day, historically
all `outcome = 'refused'` with nothing applied. Check `outcome` before treating
any of it as money.

## 8. Defensible totals (excluding reversals)

`agent_reverse_tenant_allocation` leaves `amount` intact and only marks `notes`,
so a reversed collection still counts in every dashboard total.

```sql
select coalesce(sum(amount),0) as collected_gross,
       coalesce(sum(amount) filter (where notes not ilike '%[REVERSED:%'
                                       or notes is null),0) as collected_net,
       count(*) filter (where notes ilike '%[REVERSED:%') as reversed_rows
from agent_collections
where (created_at at time zone 'Africa/Kampala')::date
    = (now() at time zone 'Africa/Kampala')::date;
```

Historically reversals are rare to non-existent, so `gross = net` most days —
which is exactly why the gap goes unnoticed until it matters.
