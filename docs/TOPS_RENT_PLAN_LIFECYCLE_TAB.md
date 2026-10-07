# Rent Plan Lifecycle tab — Renewals, Due to Complete, Expired

Study date: 2026-10-07 (Kampala). Read-only study. No code, data or logic was changed.

## 1. What we want to know (in plain words)

A new tab in **Tenant Operations Workspace** (next to Top-Up Eligibility, Communications, Registration Control, Management Overview, Payment Behavior) that answers three questions:

1. **Renewed** — how many tenants finished (or were on) a Rent Plan and then took another one.
2. **Due to complete** — how many Rent Plans are reaching the end of their window soon (e.g. next 7 / 14 / 30 days).
3. **Expired** — how many Rent Plans have passed the end of their window but the tenant still owes money.

## 2. Where the answers already live in the system

Everything comes from one record: the **Rent Plan** (`rent_requests`). Each plan has:

| What it means | Field |
|---|---|
| Who the tenant is | `tenant_id` |
| Agent responsible | `agent_id` / `assigned_agent_id` |
| When repayment starts | `repayment_starts_on` (fallback: `disbursed_at`, then `funded_at`) |
| How long the plan runs | `duration_days` |
| Daily or weekly | `repayment_frequency` |
| Total the tenant must pay | `total_repayment` |
| Paid so far | `amount_repaid` |
| Stage | `status` (`funded`, `repaying`, `completed`, plus pre-funding stages) |
| Tenancy ended / reason | `tenancy_status`, `tenancy_ended_at`, `tenancy_end_reason` |

There is **no "is renewal" flag**. A renewal is worked out: *a tenant who has more than one funded Rent Plan*; the second and later plans are renewals.

**End of window** = start date + `duration_days`. All dates must be Kampala days.

## 3. Simple definitions (one meaning each)

- **Live plan**: status `funded` or `repaying` (money was actually sent).
- **Completed**: paid ≥ total, or status `completed`.
- **Renewed tenant**: has 2+ funded plans. "Renewal rate" = renewed tenants ÷ tenants with at least one completed plan.
- **Due to complete**: live, still owing, end of window between today and today + N days.
- **Expired (over window)**: live, still owing, end of window before today. Show how many days over and the amount still owed.
- **Completed on time vs late**: completed plans, compared by last payment date vs end of window.
- Plans in review, rejected, cancelled or deleted are **never counted**. Reversed payments are excluded (amount repaid already reflects this; verify in the build).

## 4. What the numbers look like today (live, rough check)

Funded plans ever: **1,617**, across **1,214 tenants**.

| Measure | Today |
|---|---|
| Tenants who renewed (2+ plans) | **266** |
| Plans fully paid | **721** |
| Due to complete in next 14 days (still owing) | **154** |
| Expired — window passed, still owing | **556** plans, **UGX 160,954,959** owed |

These are a first look; the real tab must compute them on the server with the exact rules above.

## 5. What the tab should show (follow the existing workspace look)

Same cards, colours and table style as the Top-Up Eligibility tab. Mobile friendly at 380px.

**Cards row**
- Renewed tenants (and renewal rate %)
- Due to complete — 7 / 14 / 30 day switch
- Expired, still owing (count + UGX)
- Completed on time / late
- Live plans now

**Charts**
- Renewals per month (bar)
- Plans ending per week ahead — coming 12 weeks (bar)
- Expired plans by how late: 1–7, 8–30, 31–90, 90+ days (bar)
- Status split: live / completed / expired (donut)
- Renewals and expiries by agent (top 10) and by district

**Detail table** (search, filter, CSV/PDF export)
Tenant, phone, agent, daily/weekly, start, end of window, days left or days over, total, paid, owed, % paid, number of plans (renewal count), group (Renewed / Due / Expired / Completed).

Every figure shows a short "how this is counted" note and an "as at" time.

## 6. How to build it safely (lay steps)

1. Build **new** server functions with the `tops_` prefix that read the Rent Plans. Do not change any existing function, table or view (see `docs/TOPS_RULES.md`).
2. Build a **new** tab file inside the workspace folder that only displays those results. No money calculations in the browser.
3. Add one tab entry to the workspace tab list. Nothing else changes.
4. Check the numbers against a daily plan and a weekly plan before release.

---

## 7. Prompt 1 — server side (paste into Claude)

```
Read docs/TOPS_RULES.md, SYSTEM_CONTEXT.md and docs/TOPS_RENT_PLAN_LIFECYCLE_TAB.md first and follow them exactly.

Goal: add read-only server functions for a "Rent Plan Lifecycle" tab in Tenant Operations Workspace.

Create ONE new migration only. Do not ALTER/DROP/REPLACE any existing object, add no triggers, indexes or policies on existing tables, and write no data.

Create, all SECURITY DEFINER, STABLE, SET search_path = public, guarded with has_role(auth.uid(), ...) for tenant_ops, coo, ceo, manager, super_admin (match the role list used by existing tops_ RPCs); REVOKE EXECUTE FROM anon:

1. tops_rent_plan_lifecycle_summary(p_due_days int default 14) returns jsonb:
   - live_plans, renewed_tenants, renewal_rate, completed_plans, completed_on_time, completed_late,
     due_to_complete_count, due_to_complete_owed, expired_count, expired_owed,
     expired_buckets {d1_7, d8_30, d31_90, d90_plus}, basis text, as_at timestamptz.
2. tops_rent_plan_lifecycle_trend(p_months int default 12) returns rows: month, renewals, completions, expiries.
3. tops_rent_plan_lifecycle_upcoming(p_weeks int default 12) returns rows: week_start, plans_ending, owed.
4. tops_rent_plan_lifecycle_list(p_group text, p_search text, p_limit int, p_offset int) returns rows:
   rent_request_id, tenant_id, tenant_name, phone, agent_name, district, frequency, start_date, window_end,
   days_left (negative = days over), total_repayment, amount_repaid, owed, pct_paid, plan_number, group, total_count.

Rules:
- Source: rent_requests only for plans (plus profiles for names, existing location source for district).
- Funded = status in ('funded','repaying','completed') or funded_at not null; exclude review/rejected/cancelled/deleted.
- start = coalesce(repayment_starts_on, disbursed_at, funded_at) as Africa/Kampala date; window_end = start + duration_days.
- Completed = amount_repaid >= total_repayment or status='completed'.
- Renewal = plan_number >= 2 per tenant ordered by funded_at; renewed tenant = any tenant with plan_number >= 2.
- Due = live, owing, window_end between today and today+p_due_days. Expired = live, owing, window_end < today.
- Today = (now() at time zone 'Africa/Kampala')::date. Must work for DAILY and WEEKLY plans.
- Confirm amount_repaid excludes reversed collections; if not, derive paid from agent_collections excluding reversals and say so in the basis.

Add supabase/tests/tops_rent_plan_lifecycle.sql checking one daily and one weekly plan, and that summary counts equal list totals.
Append objects added and anything unverified to docs/TOPS_BUILD_LOG.md. Run git diff --stat and confirm nothing outside allowed folders changed.
```

## 8. Prompt 2 — screen side (paste into Claude)

```
Read docs/TOPS_RULES.md and docs/TOPS_RENT_PLAN_LIFECYCLE_TAB.md first. The tops_rent_plan_lifecycle_* RPCs already exist.

Goal: add a "Rent Plan Lifecycle" tab to src/pages/tenant-ops/TenantOperationsWorkspace.tsx, after "Payment Behavior".
The only edit to that file: one TabsTrigger (copy the exact className of the existing triggers) and one TabsContent that lazy-loads the new component. Change nothing else.

Create:
- src/hooks/tenantOpsWorkspace/useRentPlanLifecycle.ts — React Query hooks calling the four RPCs. No money arithmetic in the browser.
- src/components/tenant-ops-workspace/lifecycle/RentPlanLifecycleTab.tsx and small child components.

Layout (match the Top-Up Eligibility tab's cards, spacing, table and export buttons):
- Cards: Renewed tenants (+ renewal rate), Due to complete with a 7/14/30 day segmented switch, Expired still owing (count + UGX), Completed on time vs late, Live plans.
- Charts (recharts, semantic theme colours only): renewals/completions/expiries per month; plans ending per week for the next 12 weeks; expired by days-over bucket; status donut.
- Table with group filter (Renewed / Due / Expired / Completed), search, pagination, CSV and PDF export using existing export helpers. Columns: tenant, phone, agent, daily/weekly, start, window end, days left/over, total, paid, owed, % paid, plan number.
- Each card shows the basis text and "As at" time from the RPC. Loading skeletons, empty and error states.

Rules: formatUGX for all amounts ("UGX 50,000"), copy says "Rent Plan" never "loan", no emojis, no hardcoded colours, works one-handed at 380px.
Run npm run guard:all and npm run build. Run git diff --stat and confirm only the allowed files changed.
```
