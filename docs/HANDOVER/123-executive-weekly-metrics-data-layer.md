# 123 — Executive weekly metrics: one central data layer (P2 #11); P2 #12 held

**Built 2026-09-24. NOT YET APPLIED LIVE.** Migration
`20260924170000_executive_weekly_ops_metrics.sql`. Every query block was run read-only against
prod before commit (figures below are from that run and are illustrations, not baselines).

## What management asked for

The department numbers should come from the system even when the head of department isn't in
the room. That means one central layer, not per-dashboard queries. Each department gets:
current, 7 days ago, net change and a 7-day projection. Landlord Ops also needs the landlords
listed and the houses recognised on the platform. Dashboards consume this layer and nothing
recalculates independently.

## What was built

| Object | Role |
| --- | --- |
| `get_tenant_ops_weekly_metrics()` | Public RPC. Gate: exec roles + `tenant_ops` |
| `get_agent_ops_weekly_metrics()` | Public RPC. Gate: exec roles + `agent_ops` |
| `get_partner_ops_weekly_metrics()` | Public RPC. Gate: exec roles + `partner_ops` |
| `get_landlord_ops_weekly_metrics()` | Public RPC. Gate: exec roles + `landlord_ops` |
| `_exec_ops_metrics_raw(domain, as_of, stocks_only)` | The only place a metric is defined. Not callable by clients |
| `_exec_ops_weekly_metrics(domain)` | Shared finisher: resolves week-ago, net/% change, projection |
| `_exec_ops_metrics_authorize(role)` | `auth_required` / `not_authorized`. Exec = `is_ops_role` (manager, super_admin, coo, operations) + ceo, cfo, cto, financial_ops |
| `exec_ops_metric_snapshots` + `capture_exec_ops_metric_snapshots()` | Hourly stock snapshots (cron `exec-ops-metric-snapshots-hourly`, `7 * * * *`), 90-day prune, seeded on apply |
| `src/hooks/useOpsWeeklyMetrics.ts` | `useOpsWeeklyMetrics('tenant'|'agent'|'partner'|'landlord')` plus `indexOpsMetrics()` |

Every RPC returns one row per metric: `metric_key, label, unit (count|ugx), metric_kind
(stock|flow), current_value, week_ago_value, net_change, pct_change, projection_7d,
projection_method, week_ago_source, week_ago_at, basis, as_of`. `basis` is the plain-language
definition. Surface it in a tooltip.

## How "7 days ago" is resolved: never guessed

- **Flow** (amount over a window). Current is the last 7×24 h, and the week-ago figure is the 7×24 h
  before that. `week_ago_source = 'prior_window'`. There are two exceptions: `rent_expected_ugx`
  and `rent_collected_on_schedule_ugx` use the last 7 **complete Kampala days**, because the
  pinned bill is per Kampala day (skill `welile-expected-vs-collected`).
- **Stock, reconstructable.** The value is exact at `now() - 7 days`, taken from immutable timestamps:
  `created_at`, `verified_at`, `funded_at`, first-seen. Source: `'reconstructed'`.
- **Stock, no history in source.** This covers active Rent Plans, outstanding balance, active
  Supporters/capital, agents with live plans and advances outstanding. Plan closure and balance
  changes carry no timestamp, so the value comes from the hourly snapshot nearest `now() - 7d`
  (±3 h). **Until 7 days after apply these return `week_ago_value = NULL`, `week_ago_source =
  'no_snapshot_yet'`, `projection_method = 'unavailable'`.** That is by design, not a bug.

## Projection

| Kind | Method | Rule |
| --- | --- | --- |
| stock | `linear_wow` | `GREATEST(0, current + net_change)` |
| flow | `run_rate_7d` | next 7 days = last 7 days |
| `rent_expected_ugx` | `schedule_plus_past_term` | `rent_plan_schedule_days(today, today+6)` + 7 × yesterday's past-term fallback bill |

Why flows use a run-rate: the first draft extrapolated flows linearly, and live data broke it.
On **2026-09-16, agent collections were UGX 52.9M (617 rows)** against a ~2–5M/day norm. These
were ordinary `agent_float` cash rows spread across the day, so it looks like a genuine catch-up
burst rather than bad data. Not investigated further. That day sits in the prior window as of
09-24, so linear extrapolation projected next week's collections as `24.3M + (24.3M − 78.1M)`,
which clamps to 0.

Why rent expected needs the past-term term: `pin_agent_expected_day` also bills plans that are
past their term but still owe money, and `rent_plan_schedule_days` does not contain them. On
09-23 that was 221 plans and UGX 4.23M of the 10.53M pinned. Without it the projection read
~50% low (32.0M against a 65.6M pinned week). With it the projection is 61.6M.

## Definitions reused, not reinvented

- **Agent**: the `get_agent_ops_overview` baseline (2026-09-02). An agent is anyone who has
  collected rent, or who is the acting agent on a rent request that isn't their own. **Sub-agents =
  32,447** under the same definition the Agent Ops dashboard already uses (distinct
  `agent_subagents.sub_agent_id`, any status). That number looks inflated. It is kept for
  consistency here, and whether it should count only accepted/verified links is a question for
  Agent Ops, not something to fix silently.
- **Live Rent Plan**: status funded/repaying/disbursed/active and tenancy not ended (the same
  filter as the overview's `pending_collections`).
- **Collections**: `agent_collections`, `reversed_at IS NULL`, `amount > 0`.
  `rent_collected_ugx` is all cash in, including arrears. It is **not** the numerator for
  `rent_expected_ugx`. The on-schedule figure is per plan per day, capped at that day's bill.
- **Commission**: net wallet categories, as in the Agent Ops overview.
- **Returns distributed**: platform `roi_expense` cash_out (wallet credit + reinvestment).
  Partner funding received is platform `partner_funding`, cash_in − cash_out.
- **Landlords listed**: `landlords` rows, excluding currently rejected (46,028). This table
  has many shell or duplicate registrations, so `landlords_verified` (5,082) is the figure to lead
  with. **Houses recognised** = `house_listings.verified` by `verified_at` (7,570).
- Supporter capital withdrawals are left out: `investment_withdrawal_requests` has 9 rows, all pending,
  and none has ever been processed through it.

## Sample run (prod, 2026-09-24, read-only): current / week ago

- **Tenant:** 832 active Rent Plans, 824 tenants on a plan, UGX 283.3M outstanding. Rent expected
  was 65.6M / 60.8M; collected against the bill 12.3M / 13.6M; all cash in 24.3M / 78.1M. Plans
  funded 54 / 107.
- **Agent:** 237 / 229 agents; 66 / 63 active; collections 1,243 / 1,634 rows; net commission
  12.6M / 65.9M (the prior window holds the 09-16 burst).
- **Partner:** 883 active Supporters, 1,307 portfolios, UGX 8.71B capital. 25 / 31 new
  Supporters. Returns distributed 354.2M / 226.2M.
- **Landlord:** 5,082 / 4,978 verified landlords; 7,570 / 7,534 houses recognised; payouts
  disbursed UGX 9.96M / 72.43M.

## Not done / next

1. **Apply the migration** and verify it with `select * from get_tenant_ops_weekly_metrics()` as
   an exec user. The service role has no `auth.uid()` and gets `auth_required`. Then confirm the cron job
   exists and the first snapshot rows are in `exec_ops_metric_snapshots`.
2. **Regenerate `types.ts`** after apply (Lovable) and run `npm run schema:accept-types`. The
   hook uses `(supabase.rpc as any)` until then.
3. **Dashboards must switch to this layer (Gemini's lane).** These per-dashboard implementations
   compute overlapping figures independently today: `ops_tenant_ops_weekly_bundle`,
   `ops_agent_ops_weekly_bundle`, `ops_landlord_ops_weekly_bundle` (these also have no role gate),
   `get_agent_ops_overview`, `partner_ops_report_totals` and `get_agent_ops_kpis` (which counts
   every `user_roles.agent` row, ~58,800, because every user gets that role). Retire each one only
   after its consumer has moved.
4. **These functions are not in `critical_function_baselines`.** Add them if they become
   board-facing.

## P2 #12 — seven-day cash forecast: deliberately NOT built

The brief says to build it after items 1–5, because a forecast on a ledger that double-credits
is confidently wrong and it goes to the board. Checked 2026-09-24 against `origin/lovable`. Items
1–5 (docs 116–119) are **not all closed**:

- `cfo-direct-credit` still keys idempotency on (TID, target user). The cross-user double credit
  (TID `43274057893`, UGX 300k, doc 119) can still recur, and recovery hasn't been decided.
- `wallet-transfer` still mints a fresh `WT-` key per request (`index.ts:351`), and there is
  no per-sender lock, so retry and concurrent double-spend are still possible.
- `get_reconciliation_exceptions` is not built. That means there is no way to show "the source
  transaction behind every number" for exceptions.
- The ~114 tenant MoMo rent payments misrouted to Operational Float (doc 119 §5 a.3) are not yet
  reclassified, which would distort both the historical receivables and the float figures.

When these are closed, build #12 on `get_treasury_cash_position` (A1+A5) as opening cash.
Never use `get_treasury_snapshot`. Take expected tenant receivables from `rent_plan_schedule_days` +
the past-term fallback, the same basis as this doc. Take partnership outflows from `_cf_partner_ops_portfolios` /
`get_partner_ops_returns_forecast`. Take payroll from standing orders (watch the orphaned payroll
order, memory `project_standing_order_orphaned_payroll_daily_fail`) and approved budgets from the
six-eyes requisitions (doc 120). Every row must carry its source ids.
