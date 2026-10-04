---
name: Agent Definition (Agent Ops Dashboard)
description: Behavior-based (not role-based) definition of who counts as an Agent, with total→agents→active funnel
type: feature
---
For the Agent Ops Dashboard, an "agent" is defined by ACTIVITY, not the `user_roles` role='agent' (which is auto-assigned to ~everyone and is meaningless here). A user counts as an agent if they meet at least ONE of:
1. Listed ≥1 house (`house_listings.agent_id`)
2. Posted ≥1 promissory note (`promissory_notes.agent_id`)
3. Made ≥1 rent request on behalf of a tenant (`rent_requests` where `agent_id IS NOT NULL AND agent_id <> tenant_id` — excludes a user's own rent request)
4. Added ≥1 sub-agent directly (`agent_subagents.parent_agent_id`) OR via referral (`referrals.referrer_id`/`profiles.referrer_id`), WHERE the added/referred person themselves qualifies as an agent (RECURSIVE — transitive closure up the referral/sub-agent graph).

Computed by RPC `get_agent_ops_agent_stats(p_days int)` (SECURITY DEFINER, search_path=public) returning jsonb: total_users, total_agents, active_agents (agents with an operation in window), operations, window_days, criteria breakdown, and daily trend[]. "Active" = an agent with any qualifying operation (house list / promissory / behalf rent request / sub-agent add) in the last p_days.

UI: `src/components/executive/agent-ops-v2/AgentDefinitionFunnel.tsx` renders the Total Users → Agents → Active funnel + operations/active trend, shown at the top of `AgentOpsHomeView`. Range 24h/7d/1m maps to p_days 1/7/30.

## Canonical qualifying-agent set (system-wide, 2026-07-08)
The behavior-based definition is now enforced EVERYWHERE agents are listed, via a single source of truth:
- RPC `public.agent_ops_qualifying_agent_ids()` (SECURITY DEFINER, search_path=public) returns `TABLE(agent_id uuid)` — the recursive closure of the 4 criteria above. This is THE canonical set; do not re-derive agent lists from `user_roles.role='agent'`.
- Client hook `src/hooks/useQualifyingAgentIds.ts` wraps it (returns a `Set<string>`, `isReady`). Filter any agent list with `!isReady || ids.has(agentId)` so lists don't flash empty before load.
- `get_agent_directory_rows` / `get_agent_directory_totals` were rewritten to source agents from `agent_ops_qualifying_agent_ids()` JOIN profiles (the `agent-directory` edge fn keeps the same signature — no redeploy needed).
- `AgentRentCapacityPanel` and `FleetPerformanceStats` filter their rows through the hook too.

## AgentRentCapacityPanel modes
`AgentRentCapacityPanel` accepts `mode: 'full' | 'summary'` (default 'full'). `summary` renders only the header + KPI stats + `FleetPerformanceStats detailed={false}` (Expected/Collected/rate summary, NO search box, agent table, or expandable capacity rows). The overview uses `mode="summary"`; the full searchable capacity list lives behind the sidebar nav item `rent-capacity` ("Rent Capacity"). `FleetPerformanceStats({ detailed })` — when false, hides everything from its search box down.

## Monthly KPIs scorecard
`src/components/executive/agent-ops-v2/AgentMonthlyKpis.tsx` + RPC `get_agent_ops_monthly_kpis()` render a weighted Advance-Program scorecard on the overview: Active Agents Tracking Advances (30% weight), Monthly Advance Volume (25%), New Active Advance Agents (20%), Repayment Performance (15%), Platform Delivery & Execution (10%). Overall = Σ(weight×attainment). RPC returns raw current+previous-month metrics; attainment is computed client-side.

## Agent Ops sidebar (desktop)
`AgentOpsSideNav` in `AgentOpsDashboard.tsx`: Priority group is pinned/always-exposed on top; all other groups are collapsible (Agent Network defaultOpen and placed right below Priority). A group auto-opens when it contains the active view.
