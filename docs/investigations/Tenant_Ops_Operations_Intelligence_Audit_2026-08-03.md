# Tenant Ops → Operations Intelligence — Data & Design Audit
Date: 2026-08-03 · Read-only study. No code, data, cron or config was changed.

Scope: the "Operations Intelligence" mode of Tenant Ops
(`TenantOpsHub` → `TenantOpsGeoCommandCenter`), its data layer
(`useTenantOpsAnalytics`), the RPC `get_tenant_ops_geo_metrics`, and the three
base views `v_tenant_ops_tenant_base`, `v_tenant_ops_property_base`,
`v_tenant_ops_landlord_base`.

---

## 1. Executive summary

The dashboard is well built as a *shell*: District → Agent drill-down, 18 KPIs,
3 charts, a performance table, live RPC, no hardcoded values. The problem is
**what feeds it**. Four structural defects make most headline numbers either
meaningless or actively misleading:

| # | Defect | Effect on the screen |
|---|--------|----------------------|
| A | "Tenant" = every profile row, not every renter | Total tenants reads ~55,800 when only **883** people have a rent plan and **673** are active. Growth, arrears rate, retention, avg rent are all computed on that inflated denominator. |
| B | Money is read from two different sources | Paid today/week/month come from `repayments` (last row **2026-07-31**, 2 rows in 7 days) while collected-to-date comes from `rent_requests.amount_repaid`. Real collections live in `agent_collections` (**81 payments / UGX 1,125,200 today**). "Paid today" therefore shows 0 on a day with real money in. |
| C | Geography is free text | 24 spellings of region (`Central`, `central`, `CENTRAL`, `centreal`, `Centraltyyygg`, `ghh`), 4,006 distinct lower-cased "districts" on 23,459 listings, junk like `ndbzhsbvc`, `utgrfyuhdg`. District `Kampala` appears under 12 different "regions". The drill-down tree is built on this. |
| D | Property/occupancy linkage is broken | 23,459 non-rejected listings, only **4** marked occupied and **1** active rent plan carries a `house_listing_id`. Occupancy rate renders ~0.0%, vacancy ~100%. |

Money reconciliation gap: `repayments` totals **UGX 120,286,368** while
`rent_requests.amount_repaid` totals **UGX 293,354,363** — a **UGX 173m**
difference between the two figures the same screen puts side by side.

---

## 2. Dirty data — evidence

### 2.1 Tenant universe (view `v_tenant_ops_tenant_base`)
- 55,821 rows (equals `v_tenant_location_pivot`, i.e. essentially the whole user
  base). 54,938 have **no** rent request; 883 have one; 673 are active.
- 758 rows carry a non-Uganda country: France (411), United States (126),
  Germany (87), Canada (85), UK (14), The Netherlands (10) — all with district
  `Kampala`. These are almost certainly locale/geo-IP or free-text pollution,
  and they create phantom top-level nodes.
- `tenancy_status='ended'` is **0** platform-wide, so the "Tenant retention" KPI
  is hardwired to 100% and "ended leases" always 0.
- `schedule_delta_days` is NULL for 54,946 rows → the Payment-behaviour pie
  describes <2% of the rows the KPI band counts.
- 29 active plans have no `next_due_date`; 25 active plans have `funded_at IS
  NULL` and 13 have `daily_repayment <= 0`, so their `expected_to_date` is 0 —
  which *inflates* collection rate (collected counted, expected not).

### 2.2 Plan history is truncated
`latest_rr` keeps only the newest request per tenant. 1,142 non-rejected
requests exist for 1,003 tenants, including **371 completed** plans. Repeat
cycles, renewals and completed history are invisible; lifetime collected and
lifetime arrears per district are understated. Conversely `pending` (69 rows,
UGX 32.5m) and `agent_ops_approved` (3) requests are counted in
`outstanding_total` even though nobody has been funded yet.

### 2.3 Region / district hygiene
- Tenant regions: 24 variants for what should be 4–5 (case variants plus
  `wakiso`, `entebbe`, `seeta`, `kapamala`, `kampala centrol`, `ghh`).
- Tenant districts: 52 variants incl. `Central Region` (a region used as a
  district), `wakiiso`, `wakisu`, `Waksio`, `Mbale city`, `ndbzhsbvc`.
- Listing districts: 4,006 distinct values, 138 containing digits, 276 shorter
  than 3 characters. `v_tenant_ops_property_base` silently defaults blanks to
  region `Central` / district `Kampala`, so unknown data is *presented as*
  Kampala rather than as unknown.
- Landlords: 43,482 rows, 24,527 with no region and 24,666 with no district —
  all defaulted into Kampala; only 4,082 verified; 26,024 with no managing
  agent. The "Landlords" KPI (a 43k number next to 883 real tenants) is a
  registration artefact, not an operational figure.

### 2.4 Roles
`user_roles` has 55,852 rows with role `agent` while only **101** agents have
ever posted a rent request. The dashboard's agent counters are derived from
tenant rows so they survive, but any future "agents" metric taken from roles
will be wrong by three orders of magnitude.

---

## 3. Metric-definition problems (correct data, wrong maths)

1. **`rent_expected_monthly = sum(daily_repayment) × 30`.** Contradicts the
   agreed same-date month rule (28/30/31-day months) and ignores weekly /
   bi-weekly / monthly plans. "Collected this month %" divides real month
   payments by this synthetic figure.
2. **`rent_collected_month` is literally `paid_month` returned twice** by the
   RPC — two KPIs labelled differently show the same number.
3. **`regions_count` and `districts_count` are summed in the roll-up**
   (`rollupGeoRows`), so a distinct count becomes a sum of distinct counts:
   "N regions · M districts" over-counts whenever a region spans districts.
4. **`due_week`** uses `date_trunc('week') + 6`, i.e. calendar week-to-date, not
   "next 7 days" — on a Friday it is nearly empty and reads as good news.
5. **`arrears_rate` = arrears_count / tenants_active** but `arrears_count`
   counts *all* rows with arrears (including inactive/completed), so the rate
   can exceed 100%.
6. **`avg_rent`** roll-up weights each district's average by `tenants_total`
   (the inflated count), not by the number of tenants with a rent amount.
7. **`overdue` vs `arrears`** are two overlapping definitions
   (`next_due_date < today AND outstanding > 0` vs `arrears_amount > 0`) shown
   as separate KPIs with no explanation — ops read them as double counting.
8. **Occupancy** denominator includes 18,059 unverified and 2,281 hidden
   listings; rejected are excluded but nothing else is.
9. **No pause / grace handling.** `expected_to_date` accrues from `funded_at`
   every calendar day, so paused plans and grace periods show as arrears.
10. **No timezone label.** Everything is Africa/Kampala inside SQL but the UI
    never states "as of HH:MM EAT", and there is no data-freshness stamp.

---

## 4. UX / dashboard-standard gaps

- **No time dimension.** No date-range picker, no trend line, no
  yesterday/last-week/last-month comparison, no sparkline on any KPI. An
  operations dashboard without period-over-period deltas cannot show direction.
- **18 flat KPIs, no hierarchy.** Nothing marks the 3–4 numbers ops act on
  (money in today vs target, arrears aging, agents not collecting) versus
  context. No target/actual bars, no RAG thresholds, no "worst 10" list.
- **No arrears aging buckets** (1–7 / 8–30 / 31–60 / 60+ days) and no
  roll-rate / bucket-migration view — the single most standard collections view
  in the industry is absent.
- **No cohort or vintage view** (collection performance by funded month), so
  portfolio quality trend is invisible.
- **No exception/worklist surface.** The screen reports; it does not queue.
  There is no "tenants overdue >7 days with no contact attempt", no assignment,
  no SLA clock, no export.
- **Drill-down is only 2 levels** (district → agent) and stops at the agent
  panel; there is no district → landlord → property → tenant path, and no map
  even though `latitude/longitude` exist on listings.
- **No CSV/PDF export, no share, no scheduled email** of this view, while other
  hubs already have report exports.
- **Charts**: top-12 truncation is unlabelled ("Expected vs collected" silently
  hides the rest); no currency-scaled axes (raw UGX millions); pie chart for a
  4-state behaviour split where a 100% stacked bar per district would compare.
- **Filters are not shareable** (not in the URL) and reset on reload; "vacant"
  filter is meaningless given §2 defect D.
- Accessibility/perf: cards are `div`s with `onClick` (no keyboard role), and
  the RPC recomputes 55k rows on every 60-second stale window with no
  server-side pagination.

---

## 5. Missing in reference to the rest of the system

The platform already stores rich operational signal this dashboard ignores:

| Available today | Why Tenant Ops needs it |
|---|---|
| `agent_collections` (81 today) | The real payment feed. Should drive Paid today/week/month and daily-capacity vs target. |
| `welile_trust_score_cache` (9,333 rows) | Trust-score distribution per district, and arrears vs trust correlation — the platform's stated mission metric. |
| `agent_visits` / `venue_visits` (GPS + AI ID) | Field coverage: which arrears tenants were actually visited, visit-to-payment conversion. |
| `v_agent_daily_eligibility` + `agent_daily_eligibility_history` | Expected daily target vs collected, per agent and per district, with 14-day trend. |
| `business_advances`, `agent_advances`, `credit_access_draws` | Exposure per district; arrears net of advances. |
| `agent_landlord_payouts` / landlord float | Disbursement-to-collection lag, the true start of the tenant clock. |
| `crm_tenant_support`, `crm_customer_issues` | Complaint volume/aging per district — the missing service-quality axis. |
| `welile_homes_subscriptions` + savings | Tenant retention driver; currently absent from the tenant view. |
| `kyc_profiles`, `national ID` enforcement, `TenantPhoneDuplicatePanel` | Data-quality KPI band: % tenants with verified ID, % duplicate phones, % unknown location. |
| `house_assignment_audit`, `house_listings.tenant_id` | Would fix occupancy if assignment actually wrote back (see §2 D). |
| `system_events` | Activity timeline / audit feed per district or tenant. |

Also missing entirely: forecast (expected collections next 7/30 days),
concentration risk (share of book held by top 5 agents/landlords), churn and
renewal rate, cost-to-collect, and any notion of *target* against which the
actuals are judged.

---

## 6. Recommended sequencing (for a later build)

1. **Define the tenant.** A tenant is a person with at least one non-rejected,
   funded-or-later rent request. Everything else is a "registered user".
   This single change fixes the KPI band, growth, arrears rate and avg rent.
2. **One money source.** Make `agent_collections` (plus verified deposits) the
   collection truth for all period figures, and reconcile
   `rent_requests.amount_repaid` against it with a visible variance tile.
3. **Normalise geography.** Canonical region/district reference table with a
   mapping layer, an explicit `Unknown` bucket instead of defaulting to
   Kampala, and a data-quality panel that names the offending rows.
4. **Fix property linkage** (assignment must set `house_listings.tenant_id` /
   status) before occupancy is shown at all; until then hide the KPI rather
   than print 0.0%.
5. **Correct the metric definitions** in §3 (same-date month rule, distinct
   counts, rolling 7-day due window, single arrears definition, pause-aware
   expectation).
6. **Add the operations layer**: date range + comparison, arrears aging and
   roll rates, cohort view, target vs actual, worst-performers list, exception
   worklist with assignment and SLA, map, and export/scheduled email.
7. **Instrument quality**: a permanent "Data health" strip (unknown location %,
   missing ID %, duplicate phones, plans with no funded_at, listings never
   assigned) so dirt is visible instead of silently absorbed into KPIs.

---

## 7. One-line verdict

The frame is industry-grade; the inputs are not. Fix the tenant definition, the
single money source, geography normalisation and the property linkage, then add
time-comparison, arrears aging and an exception worklist — in that order — and
this becomes the reference tenant-operations dashboard.
