# Agent Collections Command Center — KPI card aggregation

Source of truth: live function `public.get_agent_collections_command_center(...)` and `public.agent_ops_collection_target(...)` as read from `pg_proc`, plus `src/components/executive/agent-ops-v2/AgentCollectionsCommandCenter.tsx`.

All money is in UGX. All date boundaries are UTC timestamps passed by the UI, but the RPC converts several calculations to `Africa/Kampala` local dates.

---

## 1. Collected

**Rendered:**
- Headline: `formatUGX(totals.collected)`
- Subtitle: `{collections_count} payments · avg {formatUGX(avg_collection)}`

**Aggregation (from `v_totals`):**

```sql
select
  sum(ac.amount)            as amt,
  count(*)                  as cnt,
  count(distinct ac.agent_id)   as agents,
  count(distinct ac.tenant_id)  as tenants
from agent_collections ac
where ac.created_at >= v_start
  and ac.created_at < v_end
  and ac.amount > 0
```

- `collected` = `sum(ac.amount)` in the selected UTC range, **only rows with `amount > 0`**.
- `collections_count` = `count(*)` of those rows.
- `avg_collection` = `round(collected / collections_count)` when count > 0, else 0.

**Caveat:** unlike the overview `AgentOpsOverview` tile, this count **filters out zero-amount rows** (`ac.amount > 0`).

---

## 2. Expected

**Rendered:**
- Headline: `formatUGX(expected_due)`
- Progress bar: `collected / expected_due` capped at 100%
- Subtitle: `X% of expected`
- Footnote: `Fixed at the start of each day · does not move intraday`

**Aggregation:**

The expected value is a **hybrid of frozen “pins” for elapsed days and live projection for future days**.

For each elapsed day in the selected range (`v_d1` to `least(v_d2, v_today)`), the RPC first calls `public.pin_agent_expected_day(day)`. That function writes one row per active rent plan into `agent_expected_day_plans` if the day has not been pinned yet; once pinned, the figure for that day never changes again.

Expected total is then:

```sql
select coalesce(sum(x.amt), 0)
from (
  -- Pinned elapsed days
  select sum(p.expected_ugx) as amt
  from public.agent_expected_day_plans p
  where p.day between v_d1 and least(v_d2, v_today)
  union all
  -- Future days: live schedule projection
  select coalesce(sum(
      least(s.daily_amount * (dy.d::date - s.term_start + 1), s.total_amount)
    - least(s.daily_amount * (dy.d::date - s.term_start),     s.total_amount)
  ), 0)
  from generate_series(greatest(v_d1, v_today + 1), v_d2, interval '1 day') dy(d)
  join public.v_rent_plan_schedule s
    on s.term_start <= dy.d::date and s.obligation_end >= dy.d::date
) x
```

Each day’s expected is the incremental scheduled amount for plans whose `term_start … obligation_end` covers that day.

**Caveat:** The displayed note says “does not move intraday” because each elapsed day is pinned at first read. Today is only pinned once; after that, today’s expectation is frozen.

---

## 3. Active agents

**Rendered:**
- Headline: `{totals.active_agents}`
- Subtitle: `{totals.tenants_paid} tenants paid`

**Aggregation (from the same collection CTE):**

```sql
count(distinct ac.agent_id) as agents
count(distinct ac.tenant_id) as tenants
```

- `active_agents` = distinct `agent_id` values in `agent_collections` with `amount > 0` in the UTC range.
- `tenants_paid` = distinct `tenant_id` values in the same rows.

**Caveat:** “Active” here means **collected at least one payment in the selected range**. This is different from the overview `AgentOpsOverview` definition, which also includes rent-request creation activity.

---

## 4. New rent requests

**Rendered:**
- Headline: `{totals.requests_count}`
- Subtitle: `{formatUGX(totals.requests_amount)} requested`

**Aggregation (from `rent_requests`):**

```sql
select count(*) as cnt, sum(rr.rent_amount) as amt
from rent_requests rr
where rr.created_at >= v_start
  and rr.created_at < v_end
  and coalesce(rr.status,'') not in ('deleted_by_agent','rejected')
```

- `requests_count` = number of rent requests created in the UTC range, excluding `deleted_by_agent` and `rejected`.
- `requests_amount` = `sum(rr.rent_amount)` for the same rows.

---

## 5. Defaulted

**Rendered:**
- Headline: `formatUGX(totals.defaulted_to_date)` in destructive/red color
- Subtitle: `{defaulted_plans} plans · as at {defaulted_as_of}`
- Buttons: `View all tenants owing`, `Agents gone quiet`

**Aggregation:**

Defaulted is computed **as at `v_asof = least(range_end_local_date, today_kampala)`**, not the full selected range. It is “scheduled-to-date minus paid-to-date”, with a guard against over-payments made after `v_asof`.

```sql
with due as (
  select
    s.rent_request_id,
    s.amount_repaid,
    least(
      s.daily_amount * greatest(least(v_asof - s.term_start + 1, s.oblig_days), 0),
      s.total_amount
    ) as scheduled_to_date
  from public.v_rent_plan_schedule s
),
later as (
  -- Payments received *after* v_asof reduce the defaulted figure
  select ac.rent_request_id, sum(ac.amount) as amt
  from public.agent_collections ac
  where ac.rent_request_id is not null
    and (ac.created_at at time zone 'Africa/Kampala')::date > v_asof
  group by 1
),
sh as (
  select
    greatest(0,
      d.scheduled_to_date - greatest(0, d.amount_repaid - coalesce(l.amt, 0))
    ) as shortfall
  from due d
  left join later l on l.rent_request_id = d.rent_request_id
)
select
  coalesce(sum(shortfall), 0),
  count(*) filter (where shortfall > 0)
into v_defaulted, v_defaulted_plans
from sh;
```

- `defaulted_to_date` = sum of shortfalls across all rent-plan schedule rows.
- `defaulted_plans` = count of plans with shortfall > 0.
- `defaulted_as_of` = `to_char(v_asof, 'YYYY-MM-DD')`.

**Caveat:** This is **not** filtered by the selected range; it is the whole-book position as at the range end (capped at today). The “View all tenants owing” dialog uses the same `as_of` date.

---

## 6. Field collection target today (separate card below KPIs)

**Rendered:**
- Headline: `formatUGX(target.collectible_today)`
- Subtitle: `{collectible_plans} tenants in arrears · their combined daily instalment rate`
- Breakdown:
  - **On their agreed schedule:** `on_schedule_daily` / `on_schedule_plans`
  - **Past their agreed end date:** `past_term_daily` / `past_term_plans`
- Note: `Expected above is {scheduled_today} … This target is a different measure`

**Source:** separate RPC `public.agent_ops_collection_target(p_as_of date)`.

**Aggregation:**

```sql
with b as (
  select
    s.daily_amount,
    greatest(0,
      least(s.daily_amount * greatest(least(v_asof - s.term_start + 1, s.oblig_days), 0), s.total_amount)
      - s.amount_repaid
    ) as arrears,
    case
      when v_pinned then (pin.rent_request_id is not null)
      else (s.term_start <= v_asof and s.obligation_end >= v_asof)
    end as in_term,
    case
      when v_pinned then coalesce(pin.expected_ugx, 0)
      when s.term_start <= v_asof and s.obligation_end >= v_asof
        then least(s.daily_amount * (v_asof - s.term_start + 1), s.total_amount)
           - least(s.daily_amount * (v_asof - s.term_start),     s.total_amount)
      else 0
    end as scheduled_today
  from public.v_rent_plan_schedule s
  left join public.agent_expected_day_plans pin
    on pin.day = v_asof and pin.rent_request_id = s.rent_request_id
)
select jsonb_build_object(
  'collectible_today',     coalesce(sum(daily_amount) filter (where arrears > 0), 0),
  'collectible_plans',     count(*) filter (where arrears > 0),
  'on_schedule_daily',     coalesce(sum(daily_amount) filter (where arrears > 0 and in_term), 0),
  'on_schedule_plans',     count(*) filter (where arrears > 0 and in_term),
  'past_term_daily',       coalesce(sum(daily_amount) filter (where arrears > 0 and not in_term), 0),
  'past_term_plans',       count(*) filter (where arrears > 0 and not in_term),
  'scheduled_today',       coalesce(sum(scheduled_today) filter (where in_term), 0),
  'scheduled_today_plans', count(*) filter (where in_term),
  'arrears_to_date',       coalesce(sum(arrears) filter (where arrears > 0), 0)
)
from b;
```

- `collectible_today` = sum of `daily_amount` for plans with any arrears as at `v_asof`.
- `on_schedule_daily` = portion of that collectible where the plan is still inside its agreed term.
- `past_term_daily` = portion where the plan has passed its `obligation_end` but still owes money.
- `scheduled_today` = the strict “Expected” figure for today only, i.e. the incremental amount scheduled for today across in-term plans.

**Caveat:** The UI explicitly warns not to add `Expected` and `Field collection target` together. Expected is schedule-based; the target is arrears-based (daily rate of every tenant currently behind).
