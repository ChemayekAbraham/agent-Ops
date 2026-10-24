# Agent weekly posting rule and Weekly Performance page

Engineering notes for the RentFlow / Welile dev team. This covers what changed on 23 October 2026, how it is built, how to operate it, and what to know before you touch posting, collections or the agent menus.

| | |
|---|---|
| **Status** | Live in production, enforced |
| **Enforced since** | Friday 23 Oct 2026, 12:29 UTC |
| **Migrations** | `20261023130000_agent_weekly_posting_rule.sql`, `20261023140000_agent_weekly_performance.sql` |
| **Commits** | `633d8d99fc`, `2f1c99c8e7`, `bd4b5bce97` (all on `lovable`) |
| **Agent announcement** | [`docs/agent-weekly-target-announcement.md`](./agent-weekly-target-announcement.md) |

## Contents

1. [Summary](#1-summary)
2. [The rule](#2-the-rule)
3. [Definitions](#3-definitions)
4. [Production status](#4-production-status)
5. [How it runs](#5-how-it-runs)
6. [Database objects](#6-database-objects)
7. [App changes](#7-app-changes)
8. [Weekly Performance page](#8-weekly-performance-page)
9. [Operations](#9-operations)
10. [Testing](#10-testing)
11. [Known gaps and gotchas](#11-known-gaps-and-gotchas)
12. [Change log](#12-change-log)

---

## 1. Summary

Agents used to be able to post a new Rent Plan when at least half the tenants due today or yesterday had paid something (the daily 50% rule). That rule has been replaced.

Now, every **Thursday**, the database judges each agent on the **week that just ended (Thursday to Wednesday, Africa/Kampala)**. It compares money collected against money due, and the result decides whether the agent can post new Rent Plans for the **whole new week**. Agents see where they stand on a new **Weekly Performance** page.

---

## 2. The rule

| Agent's plans billed in the judged week | Can post if they collected |
|---|---|
| Only current plans | ≥ **50%** of what the current plans were due |
| Current **and** expired plans | ≥ **50%** on current plans **and** ≥ **20%** on expired plans (two separate tests; both must pass) |
| Only expired plans | ≥ **70%** of what the expired plans were due |
| Nothing billed | Can post |

Who it applies to: **agents posting Rent Plans only.** Tenants applying for themselves are never judged on their referring agent's collections, even though the referring agent stays attached to the request (migration `20261023150000`):

| Insert path | Caller | Gated? |
|---|---|---|
| `AgentRentRequestDialog` (agent's browser) | agent | yes |
| `register-tenant` edge function | agent (service key) | yes |
| `renew_rent_request` | agent | yes |
| `submit-tenant-form` edge function (agent's shared link) | tenant via agent's link (service key) | yes |
| `tenant-self-onboarding` edge function | tenant (service key, sets `tenant_self_applied = true`) | **no** |
| `RentRequestButton` / `RentRequestForm` (tenant's browser) | tenant (signed in as the row's tenant) | **no** |

The `tenant_self_applied` flag is honoured only on inserts with no signed-in caller (the service key). A signed-in agent who sets it is still gated, and the flag is cleared on that row.

What the weekly rule replaced:

- The daily 50% (tenant-coverage) rule.
- Staff one-day exemptions (`agent_posting_gate_exemptions`).
- The "2+ good days" weekly unlock.

Per-tenant amount limits:

- Passing the week lifts the **app's** per-tenant cap (`per_tenant_max` in `useAgentCapacityMap`).
- The **database's** tenant-history cap in `get_agent_rent_request_capacity` (UGX 500k–6m, defaulting tenants blocked, UGX 100m total exposure) is **unchanged** and still applies.

---

## 3. Definitions

| Term | Definition |
|---|---|
| **Week** | Thursday 00:00 to Wednesday 23:59, Africa/Kampala. Start day comes from `agent_posting_rule_settings.week_start_isodow` (4 = Thursday). |
| **Judged week** | The most recent **completed** week. Fixed from Thursday until the next Wednesday. |
| **Window end** | `COALESCE(repayment_starts_on, funded_at::date in Kampala) + duration_days − 1`. Same expression as `v_agent_daily_eligibility.stale_debt`. |
| **Current plan** | Window had not ended by the week's Thursday. |
| **Expired plan** | Window ended before the week's Thursday, and the plan is still being billed. |
| **Group** | Each plan stays in one group (current or expired) for the whole week. |
| **Due** | Sum of the plan's `agent_expected_day_plans.expected_ugx` over the 7 days. Expired plans are still pinned daily, so one source covers both groups. |
| **Collected** | The agent's non-reversed `agent_collections` on that plan in the week (matched by `rent_request_id`, or by `tenant_id` when the row has no plan id), **capped at that plan's due**. |
| **Pass** | Compared on amounts: `collected ≥ required_pct × due`. Never on rounded percentages. |

Why collections are capped per plan: without it, one tenant overpaying hides others who paid nothing. Dividing total collections by total expected overstated one real day as 84% when true coverage was 39.7%.

---

## 4. Production status

As of 23 October 2026, judged on 15–21 October:

| Agent's plans | Agents | Can post | Blocked |
|---|---:|---:|---:|
| Current only | 40 | 16 | 24 |
| Current + expired | 43 | 3 | 40 |
| All expired | 26 | 0 | 26 |
| **Total** | **109** | **19** | **90** |

- **Next result:** Thursday 29 October, from collections 22–28 October.
- **Spot check after the switch:** one agent posted a rent request. That agent had nothing billed in the judged week, so passing was correct.

---

## 5. How it runs

### 5.1 Weekly snapshot

Two cron jobs (times in UTC):

| Job | Schedule (UTC) | Kampala time |
|---|---|---|
| `snapshot-agent-weekly-posting-eligibility` | `15 21 * * 3` | Thursday 00:15 |
| `snapshot-agent-weekly-posting-eligibility-am` | `0 3 * * 4` | Thursday 06:00 |

Both run `snapshot_agent_weekly_posting_eligibility()`. It deletes and rewrites the judged week's rows in `agent_weekly_posting_eligibility`. The 06:00 run picks up collections that synced late overnight, before agents start work.

### 5.2 The gate on rent_requests

On every `rent_requests` insert with an `agent_id`, the existing trigger `tr_enforce_agent_daily_eligibility` calls `enforce_agent_daily_eligibility()`:

1. If `app.bypass_daily_eligibility = 'true'` or `agent_id` is null, allow.
2. If it's a tenant self-application, allow:
   - the signed-in caller is the row's tenant and not its agent; or
   - `tenant_self_applied` is true and there is no signed-in caller (otherwise the flag is cleared).
3. If `agent_posting_rule_settings.enforce_weekly` is true:
   - read `_agent_weekly_posting_result(agent_id)`;
   - if it fails, raise `WEEKLY_ELIGIBILITY_BLOCKED: <reason>` (`check_violation`);
   - otherwise allow.
4. Otherwise, run the old daily rule (unchanged, unreachable while the flag is on).

Renewals also insert into `rent_requests`, so they go through the same gate.

### 5.3 Missing snapshot fallback

`_agent_weekly_posting_result(agent)` returns:

| Situation | Result |
|---|---|
| Saved row exists for the judged week | That row |
| Job ran for the week, but no row for this agent | `NULL` → nothing billed → passes |
| Job has not run for the week at all | Live computation via `_agent_weekly_posting_compute` |

A failed job therefore never blocks everyone.

### 5.4 The app

`useAgentCapacityMap` calls `get_agent_weekly_posting_eligibility`. When the returned `enforced` column is true:

- `can_post_rent_today` comes from the weekly result;
- the rent request form shows the server's reason.

Client reads **fail open**; the trigger is the real gate. One flag, `enforce_weekly`, switches the database and the app together.

---

## 6. Database objects

### 6.1 Tables

| Table | Contents | Access |
|---|---|---|
| `agent_posting_rule_settings` | One row: `week_start_isodow`, `in_window_required_pct` (0.50), `expired_required_pct` (0.20), `all_expired_required_pct` (0.70), `enforce_weekly`, `updated_at` | `authenticated`: select. `service_role`: all. |
| `agent_weekly_posting_eligibility` | One row per agent per judged week: due / collected / plan count per group, `book`, percentages, required percentages, `passes`, `reason`, `computed_at`. PK `(agent_id, week_start)`. | RLS: own row or `can_view_staff_reports`. `authenticated`: select. `service_role`: all. |

`book` values: `none`, `in_window_only`, `mixed`, `all_expired`.

### 6.2 Functions

| Function | Purpose | Callable by |
|---|---|---|
| `_agent_rule_week_start(day)` | First day of the rule week containing `day` | `service_role` |
| `_agent_rule_judged_week_start()` | First day of the judged (last completed) week | `service_role` |
| `_agent_weekly_posting_compute(week_start, agent_ids)` | The calculation. Pure read. `NULL` ids = every billed agent. | `service_role` |
| `_agent_weekly_posting_result(agent)` | Saved row for the judged week, else live (see 5.3) | `service_role` |
| `snapshot_agent_weekly_posting_eligibility(week_start)` | Writes a week's rows. Re-runnable. Default = judged week. | `service_role` |
| `get_agent_weekly_posting_eligibility(agent_ids)` | App read for the capacity hook; adds `enforced` | `authenticated` (self, network, staff) |
| `_agent_weekly_plan_lines(agent, week_start, through)` | Per-plan lines for a week, using bill days up to `through` | `service_role` |
| `get_my_weekly_performance(weeks, agent)` | Weekly Performance page document | `authenticated` (self, network, staff) |
| `enforce_agent_daily_eligibility()` | Trigger function, now weekly-aware (see 5.2) | trigger |

`anon` can execute none of these.

### 6.3 `get_my_weekly_performance` response

```jsonc
{
  "agent_id": "…",
  "settings": { "in_window_required_pct": 0.5, "expired_required_pct": 0.2,
                "all_expired_required_pct": 0.7, "enforced": true },
  "current_week": {               // this week so far, with a full-week projection
    "week_start", "week_end", "today", "days_elapsed", "days_left", "book",
    "in_window_due_so_far", "in_window_collected", "in_window_plans", "in_window_projected_due",
    "expired_due_so_far", "expired_collected", "expired_plans", "expired_projected_due",
    "in_window_required_pct", "expired_required_pct"
  },
  "weeks": [ /* last N completed weeks, newest first; weeks[0].is_judged = true */ ],
  "plans": [ /* this week's plans: tenant_name, tenant_phone, expired, due_so_far,
                collected (capped), paid_raw, daily_due */ ]
}
```

- `weeks[0]` (the judged week) reads the same saved result the gate uses. Older weeks are recomputed.
- `*_projected_due` = due so far + today's per-plan bill × days left.

---

## 7. App changes

| File | Change |
|---|---|
| `src/hooks/useAgentCapacityMap.ts` | Reads the weekly RPC. New optional fields `posting_rule` (`'daily' \| 'weekly'`) and `weekly_posting`. Under weekly: `can_post_rent_today` from the result; `unlimited_posting` and `posting_exempt_today` forced false; per-tenant cap lifted only on a pass. |
| `src/components/agent/AgentRentRequestDialog.tsx` | Blocked toast and submit error use the server's weekly reason with "this week" wording; `WEEKLY_ELIGIBILITY_BLOCKED` translated in `humanizeCapacityError`. |
| `src/lib/renewalAdvice.ts` | `renewalErrorMessage` passes the server's weekly reason through. |
| `src/pages/agent/AgentWeeklyPerformance.tsx` | New page at `/agent/performance`. |
| `src/hooks/useMyWeeklyPerformance.ts` | Data hook for the page. |
| `src/lib/weeklyPerformance.ts` | Types, parsing and target arithmetic for the page. |
| `src/App.tsx` | Route `/agent/performance` (RoleGuard: agent, super_admin, manager, operations, ceo, coo, cto). |
| `src/components/DashboardHeader.tsx` | "Weekly Performance" item with a New badge in the agent top-bar ☰ menu, directly under "More". |
| `src/components/agent/AgentMenuDrawer.tsx` | New "📈 Performance" tab after "⋯ More" in More Actions. |

---

## 8. Weekly Performance page

Route: `/agent/performance`. Read-only.

| Section | Shows |
|---|---|
| Status banner | Green or red: can the agent post this week, the server's reason if not, and when the next result lands |
| This week so far | One card per group: progress bar with a target line, collected / expected / target, amount left to collect by Wednesday and per day, "On track" or "Behind target" |
| Last week's result | The same cards for the judged week |
| Your tenants this week | Each plan's collected vs billed so far, Current / Expired badge, call button, filter (All / Current / Expired) |
| Past weeks | Last six weeks with pass/fail and percentages |
| How the weekly target works | Short explanation, collapsible |

"Expected this week" is a **projection**: what's been billed so far, plus today's bill per plan repeated for each day left. The page says so.

---

## 9. Operations

### 9.1 Change a percentage or the week's start day

```sql
UPDATE public.agent_posting_rule_settings
   SET in_window_required_pct   = 0.50,
       expired_required_pct     = 0.20,
       all_expired_required_pct = 0.70,
       updated_at = now();

-- Re-save the judged week so the gate and the app agree:
SELECT public.snapshot_agent_weekly_posting_eligibility();
```

### 9.2 Switch back to the daily rule

No deploy needed:

```sql
UPDATE public.agent_posting_rule_settings SET enforce_weekly = false, updated_at = now();
```

### 9.3 Check one agent

```sql
SELECT *
  FROM public.agent_weekly_posting_eligibility
 WHERE agent_id = '<uuid>'
   AND week_start = public._agent_rule_judged_week_start();
```

### 9.4 Re-run a week by hand

```sql
SELECT public.snapshot_agent_weekly_posting_eligibility();              -- judged week
SELECT public.snapshot_agent_weekly_posting_eligibility('2026-10-15'); -- a specific week
```

### 9.5 Remove the feature completely

Run `supabase/rollbacks/20261023130000_agent_weekly_posting_rule.rollback.sql`. It restores the daily-only trigger, unschedules the jobs, and drops the functions and tables. Also drop `get_my_weekly_performance` and `_agent_weekly_plan_lines` (from `20261023140000`), which stop working once the rule's functions are gone, and remove the Weekly Performance menu items.

### 9.6 Applying migrations

These migrations are applied by hand:

```bash
supabase db query --linked -f supabase/migrations/<file>.sql
```

They are not recorded in `supabase_migrations.schema_migrations`. **Lovable must not re-run them.**

---

## 10. Testing

| Test | What it checks | How to run |
|---|---|---|
| `supabase/tests/agent_weekly_posting_rule.sql` | 12 checks: week arithmetic, saved = live, 50/20/70 logic and reasons, per-plan cap, access (self / other agent / anon), gate with the flag on | Against the live DB. Ends in `RAISE EXCEPTION 'REPORT …'`, so nothing is kept; the error text is the report. |
| `supabase/tests/agent_weekly_performance.sql` | 7 checks: plan lines add up to saved results for every agent, judged week matches the gate, current-week cap and projection, access | Same as above |
| `supabase/tests/tenant_self_applications_not_gated.sql` | 8 checks: each insert path (agent, agent faking the flag, tenant in app, self-onboarding, register-tenant, agent as own tenant) against a blocked and a passing agent, using the real gate function on a temp table | Same as above |
| `src/test/agentWeeklyPerformance.test.tsx` | Target arithmetic, date formatting, page renders status / groups / tenants / history / filter, error state, no banned words | `npx vitest run src/test/agentWeeklyPerformance.test.tsx` |
| `src/lib/__tests__/renewalAdvice.test.ts` | `WEEKLY_ELIGIBILITY_BLOCKED` message pass-through | `npx vitest run src/lib/__tests__/renewalAdvice.test.ts` |

Also run `npm run guard:all` before shipping changes in this area.

---

## 11. Known gaps and gotchas

| Item | Detail | Owner |
|---|---|---|
| Rating banner in the rent request form | Still shows today's and yesterday's tenant counts. Weekly figures are available on `cap.weekly_posting`. | UI (Gemini) |
| Executive capacity PDF | `AgentRentCapacityPanel` still derives "can post" from the daily status. | Logic |
| Dead daily-rule code | Trigger branch, daily logic in the hook, exemptions reads. Unreachable while `enforce_weekly` is on; delete once the weekly rule has settled. | Logic |
| New tenants | A plan funded today is billed from tomorrow, so new tenants count from the day after funding. | n/a (by design) |
| Server reasons | The `reason` text is written by the database and shown to agents as is. Keep "Rent Plan" wording if you change it. | Logic |
| Migration history | Hand-applied; not in `schema_migrations`. Check `to_regprocedure(...)` before assuming an object exists. | Everyone |

---

## 12. Change log

| Date | Ref | Change |
|---|---|---|
| 23 Oct 2026 | `20261023130000` | Weekly posting rule: settings, snapshot table, compute, gate, cron. Applied in shadow mode. |
| 23 Oct 2026 | `633d8d99fc` | Rule, capacity hook, rent request form, error handling |
| 23 Oct 2026 | (settings) | `enforce_weekly` switched on, 12:29 UTC |
| 23 Oct 2026 | `20261023140000` | `get_my_weekly_performance`, `_agent_weekly_plan_lines`. Applied. |
| 23 Oct 2026 | `2f1c99c8e7` | Weekly Performance page, route, More Actions tab, tests |
| 23 Oct 2026 | `bd4b5bce97` | Top-bar menu item; agent announcement |
| 23 Oct 2026 | `20261023150000` | Tenant self-applications no longer gated: `rent_requests.tenant_self_applied`, gate updated. Applied; `tenant-self-onboarding` v30 deployed. |
