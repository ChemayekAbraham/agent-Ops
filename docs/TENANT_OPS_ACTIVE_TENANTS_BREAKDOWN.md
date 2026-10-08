# Tenant Ops: How "Active Tenants" Is Counted, and a Proposed Breakdown

Written 8 Oct 2026, 10:05 Kampala time. Read-only study. Nothing was changed.

## 1. What the button counts today

The **Active Tenants** card on Tenant Ops → Classic home showed **811** (812 when checked a moment later).

It counts **each tenant once** if they have at least one Rent Plan that meets all of these:

1. The plan status is **funded** or **repaying**.
2. The agent has **not** marked the tenant "Not Paying".
3. The tenant **still owes** money (total to repay is more than amount repaid).
4. The plan is **not paused**.
5. The plan was not reversed, unless the tenant had already paid something.
6. The landlord has been paid, or the tenant has started paying, or no landlord money is still waiting with the agent.

If a tenant has more than one plan, the one with the biggest balance is used.

### What is left out
- **Completed plans are not counted.** A tenant who has finished paying is no longer "active".
- Tenants with no Rent Plan, or only pending, rejected or cancelled requests.

### The date filter does not change this number
"Active Tenants" is a **live count as of right now**. Picking Today, This Week or a custom range does **not** change it. Only the small line under it ("33 paid today") follows the date filter.

"Paid" there means the tenant paid at least **half** of what they should have paid in the chosen days.

## 2. The gap with what you want

You define active as **completed + funded + repaying**. The system currently uses **funded + repaying, still owing, not paused** only. The two numbers will never match until we agree on one definition. The proposal below keeps today's number and shows completed as its own group next to it, so nothing breaks.

## 3. Live numbers right now (one plan per tenant)

| Group | Tenants | Still owed | Paid in last 7 days |
|---|---|---|---|
| Repaying | 788 | UGX 302,592,942 | 406 (about 52%) |
| Funded (money with the agent, not yet repaying) | 24 | UGX 11,075,269 | 0 |
| **Active total** | **812** | **UGX 313,668,211** | |
| Completed (finished, no open plan) | 335 | none | |

Across all records, 536 tenants have at least one completed plan; 201 of those also have a newer open plan, so they appear in "Active" instead.

Things to note:
- **"Repaying" is a status, not proof of payment.** Only about half of repaying tenants actually paid in the last week. The other 382 are "repaying" in name only.
- Note: 58 tenants have a funded plan in total, but only 24 count here; the rest are paused, marked Not Paying, or already counted under a repaying plan.

## 4. Proposed breakdown (what you would see)

Clicking Active Tenants opens a breakdown with these groups:

1. **Funded**: the agent holds the money in float; the landlord may not be paid yet. Show count, amount held, how many days since funding.
2. **Repaying, actually paying**: paid at least once in the chosen dates. Show count, amount collected, average paid vs. expected.
3. **Repaying, not paying**: status says repaying but no payment in the chosen dates. Show count, amount owed, days behind.
4. **Completed**: finished plans. Show plans completed **within the chosen dates**, and the all-time total.

How the date filter should work for each group:
- Funded / Repaying: "active at any point in the dates", with paid/not-paid judged on payments inside the dates.
- Completed: plans whose final payment landed inside the dates.
- "Today" shows today's position; a past range shows the position for that range.

Each group opens a list of tenants (name, agent, phone, balance, last payment date) with a download button.

## 5. Decisions needed before building
1. Should the headline number stay "still owing" (812), or include completed (about 1,150)? Recommendation: keep 812 and show completed beside it.
2. What counts as "actually paying"? Any payment in the dates, or at least half of what was due (the current rule)?
3. A completion date is needed. Plans have no clean "completed on" date today; the last payment date would be used instead.

---

## Prompt 1: server side (paste into Claude)

```
READ-ONLY FIRST, then build. Use "Rent Plan", "Supporter", "Returns" in all copy.
Goal: add a read-only, role-gated RPC public.ops_tenant_active_breakdown(p_start timestamptz, p_end timestamptz)
returning jsonb, using the same auth check and Kampala day-window logic as public.ops_tenant_ops_home_range.

Groups (one Rent Plan per tenant, same pick rule as ops_tenant_ops_home_range: largest outstanding, then latest start):
- funded: rows of v_tenant_daily_eligibility with status='funded'. Return count, sum outstanding,
  sum held in agent float (agent_landlord_float_allocations open/partially_paid), avg days since funded_at.
- repaying_paying: status='repaying' AND has a non-reversed agent_collections row (amount>0) inside the window.
  Return count, collected in window, expected in window (agent_expected_day_plans), outstanding.
- repaying_not_paying: status='repaying' with no such collection in window. Return count, outstanding, avg missed days
  (same missed-days formula as ops_tenant_ops_home_range).
- completed_in_window: rent_requests status='completed' whose last non-reversed agent_collections created_at is in the window
  (distinct tenants and plan count, total repaid); plus completed_all_time distinct tenants without an open plan.
Also return active_total that MUST equal ops_tenant_ops_home_range.active_tenants for the same window.
Add a second RPC ops_tenant_active_breakdown_list(p_group text, p_start, p_end, p_limit int, p_offset int)
returning tenant name, phone, agent name, plan status, outstanding, last payment date, collected in window.
SECURITY DEFINER, SET search_path = public, STABLE. No writes. Verify all columns against the live schema first
(migrations folder is not reliable). Test: funded + paying + not_paying equals active_total for today, this week and a custom month.
Record the definition as one rule in AGENTS.md.
```

## Prompt 2: screen (paste into Claude)

```
In src/components/executive/tenant-ops/TenantOpsHome.tsx, the "Active Tenants" card currently navigates to all-tenants-hub.
Change it to open an "Active Tenants breakdown" panel (sheet on desktop, full page on mobile, no horizontal scroll)
driven by ops_tenant_active_breakdown with the page's existing date filter (startIso/endIso), via a new hook
src/hooks/useTenantActiveBreakdown.ts (React Query, key includes the window).
Show four cards: Funded (money with agent), Repaying – paying, Repaying – not paying, Completed in period
(with all-time completed as a small note). Each card: count, UGX amounts via formatUGX, short plain-English hint.
Include a stacked bar of the three active groups that adds up to the headline Active number, and a line that says
"Active = still owing on a funded or repaying Rent Plan. Completed plans are shown separately."
Clicking a card opens a paged tenant list from ops_tenant_active_breakdown_list with search and CSV download.
Use semantic design tokens only, no hardcoded colors. No writes, no money movement.
Verify in the browser at 1280px and 390px for Today, This week and a custom range, and confirm the groups sum to the card.
```
