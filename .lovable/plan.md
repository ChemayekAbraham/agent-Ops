# Plan: Agent Ops Rent Behaviour

## What will change
- Add a new Agent Ops child item called `Rent Behaviour` under Field Operations.
- Make the item open a real panel instead of leaving the dashboard stuck on an empty/invalid section.
- Build a Rent Behaviour panel that tracks tenant repayment behaviour by tenant-agent pair.

## Rent Behaviour panel
- Top KPI row with 4 cards:
  - tenants tracked
  - total collected
  - on-time repayment rate using a 2-day window from the previous collection/rent event
  - remaining balance still to collect
- Tenant list below the KPIs, loading 15 rows per fetch with Next and Prev controls.
- Each row will show:
  - agent name, avatar, phone
  - tenant name, passport/avatar image
  - last collection date and time
  - amount collected
  - amount still to be collected
  - collection mode: Daily, Weekly, Monthly
  - collection/repayment count
- Clicking a row opens a drilldown view with:
  - number of rent requests posted
  - collection financial statement/list
  - agent commission earned
  - remaining balance
  - a full tenant profile entry point
- Add CSV and PDF export for the currently loaded tenant metadata.

## Performance approach
- Add backend reporting RPCs so the browser does not perform N+1 lookups.
- The list RPC will return already-joined agent, tenant, rent request, collection, balance, and behaviour fields in one paginated call.
- The drilldown RPC will return all tenant-level detail in one call.
- Use stable query keys and a single React Query request per page/drilldown.
- Keep selects type-safe without expensive select-string parsing patterns.

## Technical details
- Database migration:
  - create `get_agent_ops_rent_behaviour(p_limit, p_offset)` for paginated summary rows and KPIs
  - create `get_agent_ops_rent_behaviour_detail(p_tenant_id, p_agent_id)` for row drilldown
  - secure both functions with role checks for Agent Ops/operations/management roles
- Frontend:
  - create `AgentRentBehaviourPanel.tsx`
  - add `rent-behaviour` to `AgentOpsDashboard` `ActiveView`, `NAV_ITEMS`, `renderSubView`, and Field Operations side-nav group
  - reuse existing `UserProfileDialog`, `Button`, `Card`, `Badge`, and `downloadAuditPdf`
- Validation:
  - verify the new nav item opens the panel and does not get stuck
  - verify pagination and exports work
  - check build output after code changes
