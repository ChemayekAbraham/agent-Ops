# Agent Monitoring vs Workspace vs Weekly Performance — Tuesday 13 Oct 2026

Read-only check against the live database. All three pages now count each Rent Plan from the same start: the Kampala day after the last counted landlord payout (`am_plan_clock`). Where a figure is not on a page, that page shows a dash. Figures are taken from the same database functions the pages read (`am_plan_clock`, `am_plan_arrears`, the Workspace `_amclock` schedule and the Weekly Performance function), restricted to each page's own plans; they were not read off the screens. (`/mnt/documents` does not exist here, so this is in `docs/`.)

## The figures

| Line | Agent Monitoring | Workspace | Weekly Performance |
|---|---|---|---|
| Active plans counted | 801 | 850 | 789 |
| Due today (UGX) | 6,113,326 | 6,113,326 | — |
| Arrears total (UGX) | 214,810,699 | 225,043,696 | — |
| Plans / tenants behind | 791 | 832 | — |
| Non-paying (no payment this week since the clock start) | — | — | 380 |
| Landlord not paid yet | 109 | 107 | 98 |

Every line that differs is a difference in **which plans** a page includes, not in how any plan is counted. Same-plan checks are at the bottom.

## Why each line differs

**Active plans: 801 / 850 / 789.** The shared clock counts 848 live plans from a start on or before today.
- Agent Monitoring shows 801: it lists only plans in the daily-collection list (`v_tenant_daily_eligibility`) with an agent. That leaves out 47 (2 with no agent, 45 not in the daily-collection list).
- Workspace shows 850: the 848, plus 2 plans whose hand-set start (an `override` in `tops_plan_clock`) is kept by decision. Both sit in the landlord-not-paid bucket on the shared clock, and the Workspace keeps counting them as owing.
- Weekly Performance shows 789: one plan per tenant (their latest) and only where the agent has not marked the tenant as not paying. That leaves out 59 (37 marked not paying, 22 older plans of tenants with a newer plan).

**Due today: 6,113,326 on both.** The 2 hand-set plans have nothing due today, so the extra plans in the Workspace add nothing.

**Arrears total: 214,810,699 vs 225,043,696.** The 10,232,997 gap is exactly the populations again: 801 vs 850 plans. Of it, 1,243,715 is the 2 hand-set plans (205,028 + 1,038,687, plans `532be737` and `6be06a42`); the rest is the 47 plans Agent Monitoring does not list.

**Plans behind: 791 vs 832.** Same reason: 801 vs 850 plans.

**Non-paying: 380.** Only Weekly Performance shows this. It equals an independent count from the payment tables: counted plans with no collection or repayment dated in the week on or after their clock start. Agent Monitoring answers a different question (collected today against expected today), and the Workspace shows arrears, not a weekly non-paying count.

**Landlord not paid yet: 109 / 107 / 98.**
- Agent Monitoring's two tabs list every live plan with no counted payout: 59 tenant paying + 50 awaiting landlord = 109.
- Workspace shows 107: it leaves out the 2 hand-set plans, because it counts them as owing.
- Weekly Performance shows 98: it leaves out 9 older plans of tenants with a newer plan and 2 plans whose tenant is not in the Tenant Ops tenant list.

## Same plans, same answer

| Check on the same plans | Result |
|---|---|
| Due today, Agent Monitoring maths vs Workspace schedule, all 848 plans | 6,113,326 = 6,113,326 |
| Arrears, Agent Monitoring maths on the 848 vs Workspace without the 2 hand-set plans | 223,799,981 = 225,043,696 − 1,243,715 |
| Arrears on the 801 Agent Monitoring plans: Workspace vs Agent Monitoring | difference 205,028 = the one hand-set plan inside that list |
| Weekly active + landlord-not-paid vs the shared clock on the same plans | 789 + 98 = all live plans in the weekly set |
| Weekly non-paying vs an independent rebuild | 380 = 380 |
| `am_plan_clock` bucket and start for every live plan, Workspace and Weekly vs Agent Monitoring | 0 differences (957 plans) |

The daily check (`am_detect_clock_drift`) does this comparison every morning for every live plan and records any plan that differs. Today: 957 plans checked, 0 unexplained, 2 explained (the hand-set starts).

## Live plans with no saved start (`tops_plan_clock` row)

237 live plans have no row today (it was 219 earlier). Nothing was inserted.
- 213 are counted by the shared clock (212 counting, 1 outstanding balance), and all 213 are in the Workspace's `_amclock` clock.
- 24 have no counted landlord payout (awaiting landlord) and are listed as landlord-not-paid.
- 0 counted plans are missing from the Workspace.

## Not changed by this work
Existing views, triggers, policies, the agent dashboard and Priority Collections. The two hand-set starts stay exactly as set.
