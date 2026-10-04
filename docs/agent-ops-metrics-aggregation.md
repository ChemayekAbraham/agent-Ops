# Agent Operations dashboard — how the headline figures are aggregated

Source of truth read directly from the live RentFlow database (`pg_proc`) and the
components that render them. Nothing below is inferred; every rule is copied from
the function body or the component that displays it.

Two different backends feed the surfaces:

| Surface | Backend |
| --- | --- |
| Agent Operations Overview (`AgentOpsOverview.tsx`) | `public.get_agent_ops_overview(p_range_start, p_range_end)` |
| Agent Collections Command Center (`AgentCollectionsCommandCenter.tsx`) | `public.get_agent_collections_command_center(p_start, p_end, p_bucket)` |

Both are authorisation-gated (ops roles, manager, CEO/COO/CFO/CTO, super_admin).
Comparison ("previous") windows in the overview are the same span immediately
before the selected range: `prev_start = range_start − (range_end − range_start)`,
`prev_end = range_start`. Deltas shown on the tiles are
`((curr − prev) / prev) × 100`, or 100% when the previous value is zero and the
current one is positive.

---

## 1. Total Collected

- KPI key: `collections_curr`, delta against `collections_prev`.
- Definition: `SUM(agent_collections.amount)` where
  `created_at >= range_start AND created_at < range_end`.
- No filter on agent, status, tenant or amount. Every row in `agent_collections`
  inside the window counts, including sub-agent rows.
- Subtitle on the "Today" preset shows `collections_today` =
  `SUM(amount)` where `created_at::date = today (Africa/Kampala)`.
- The trend chart's green "Collected" series is the same sum bucketed by
  `date_trunc('day' | 'hour', created_at)` over the last 30 days.

Note: the tile itself uses `created_at` in UTC bucketing for the range, while
`collections_today` is date-truncated in Africa/Kampala. Those two can disagree
by the rows falling in the 21:00–00:00 UTC window.

## 2. Total Expected

The overview KPI row has no "Total Expected" tile — expected appears in two
places, computed two different ways.

**a) Overview trend chart (`expected` / red "Pending" series)**

```
expected(bucket) = SUM(rent_requests.daily_repayment)
  for plans with status IN ('funded','repaying','disbursed','active')
  AND COALESCE(tenancy_status,'active') <> 'ended'
  AND COALESCE(disbursed_at, funded_at, approved_at, created_at) <= bucket_ts
```
divided by 24 when the bucket is hourly. This is a live re-derivation from the
current plan rows — it is not frozen and moves as plans change status.

**b) Collections Command Center "Expected" (`expected_due`)**

Basis label returned by the function: `pinned_schedule`. It is the sum of two
disjoint parts:

- **Elapsed days** (`day` between range start and `min(range_end, today)`):
  read from `agent_expected_day_plans`. Each elapsed day is frozen once by
  `pin_agent_expected_day(day)`, which inserts one row per rent request from
  `rent_plan_schedule_days(day, day)` joined to `v_rent_plan_schedule`, and
  returns 0 (no rewrite) if the day already has rows. Once pinned, the figure
  for that day never changes again.
- **Future days** (after today, when the range extends forward): projected live
  from `v_rent_plan_schedule` as the day's incremental scheduled amount,
  `least(daily_amount × elapsed_days, total_amount) − least(daily_amount ×
  (elapsed_days − 1), total_amount)`, for plans whose `term_start … obligation_end`
  covers that day.

Coverage shown under the tile is `collected / expected_due`, and the daily
expected bar chart is the same pinned/projected series per day.

## 3. Pending Collections

- KPI key: `pending_collections`. It has **no** date range and **no** delta.
- Definition:
  ```
  SUM( GREATEST( COALESCE(total_repayment,0) − COALESCE(amount_repaid,0), 0 ) )
  FROM rent_requests
  WHERE status IN ('funded','repaying','disbursed','active')
    AND COALESCE(tenancy_status,'active') <> 'ended'
  ```
- So it is the whole-book outstanding balance on live rent plans as of now, not
  "pending in the selected period". The subtitle "Outstanding on live rent plans"
  matches the SQL.
- The chart's per-day `pending` is a different quantity:
  `GREATEST(expected(bucket) − collected(bucket), 0)` — a daily shortfall, not
  the book balance.

## 4. Total Collections (count)

- KPI key: `collections_count_curr`, delta against `collections_count_prev`.
- Definition: `COUNT(*)` of `agent_collections` rows in the window — the number
  of collection events, not money. `collections_today_count` is the same count
  for today (Kampala date).
- The Command Center's own `collections_count` additionally filters
  `amount > 0`; the overview count does not, so a zero-amount row would be
  counted by the overview tile but not by the Command Center.

## 5. Total Agents & Sub-Agents

Agents and sub-agents are two separately derived sets, then added in the UI.

**Agent set (`tmp_qual`)** — baseline rule dated 2026-09-02 in the function
comment. A user qualifies as an agent, with `first_ts` = earliest of:

- `MIN(agent_collections.created_at)` per `agent_id`, or
- `MIN(rent_requests.created_at)` per `COALESCE(assigned_agent_id, agent_id)`,
  any status, excluding rows where that agent id equals `tenant_id`
  (self-requests do not make someone an agent).

Role assignment is not consulted at all — behaviour defines an agent.

**Sub-agent set (`tmp_sub`)** — every distinct `agent_subagents.sub_agent_id`
with `first_ts = MIN(created_at)`. No status/verification filter is applied in
this function.

Derived keys:

- `total_agents` / `total_subagents` — members whose `first_ts < range_end`
  (cumulative as at the end of the range, not "created in the range").
  `*_prev` uses `first_ts < prev_end`.
- `new_agents_curr` / `new_subagents_curr` — `first_ts` inside the range.
- `active_agents_curr` / `active_subagents_curr` — distinct `agent_id` appearing
  in `agent_collections` inside the range, intersected with the agent set or the
  sub-agent set respectively. Active therefore means "collected rent in the
  window"; a rent request alone does not make an agent active.

How the tiles combine them:

| Tile | Value | Subtitle |
| --- | --- | --- |
| Total Agents | `total_agents + total_subagents` | `+ (new_agents_curr + new_subagents_curr)` new in range |
| Active Agents | `active_agents_curr + active_subagents_curr` | active agents · active sub-agents |
| Inactive Agents | `(total_agents + total_subagents) − (active_agents_curr + active_subagents_curr)` | inactive agents · inactive sub-agents |

Consequence to be aware of: a user can be in **both** sets (an agent by
behaviour who is also linked as a sub-agent). Nothing de-duplicates across
`tmp_qual` and `tmp_sub`, so such a user is counted twice in the combined
totals and twice in the combined active count. The "Top performers" table does
disambiguate — it labels a user `Sub-Agent` when present in `tmp_sub`, else
`Agent`.

## Refresh behaviour

The overview subscribes to realtime changes on `general_ledger`, `rent_requests`,
`agent_collections` and `house_listings` and invalidates the query on any change.
Query `staleTime` is 60s. The trend chart always requests the last 30 days
regardless of the selected preset, so the KPI row and the chart can cover
different windows.
