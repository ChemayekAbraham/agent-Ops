# Service Center: fix the slow load behind the "New" tag

## What the red "New" tag actually is

The tag on the Service Center button in `src/components/agent/AgentHubTabs.tsx` (line 61) is pure static markup — a styled `<span>` with the text "New" and a small yellow dot. It reads no data, runs no animation loop, and costs nothing. It is not the cause of the slow load, so nothing about the badge needs changing (unless you want it removed once the feature stops being "new").

## Where the slowness really comes from (verified)

Tapping the button navigates to `/agent/service-center` (`AgentServiceCenter`, a lazy route). That page fires six queries at once, and one of them — `get_agent_service_center()` — is a single monolithic RPC that builds the *entire* team dataset in one JSON blob before anything can render:

- per sub-agent it embeds full `tenant_list`, `landlord_list` and `house_list` (with photo arrays), not just counts
- for the heaviest parent agent in production today that means 96 sub-agents, 2,872 house rows, 1,815 landlords, 238 referred tenants in one response; another has 105 sub-agents / 508 landlords
- the roster list is capped at 20 cards on screen, so nearly all of that payload is transferred and parsed for nothing
- the whole roster tab is gated on `isLoading` of that one query, so the user stares at skeletons until the largest piece of work finishes

The relevant indexes (`agent_subagents(parent_agent_id,status)`, `rent_requests(agent_id)`, `house_listings(agent_id)`, `profiles(referrer_id)`) already exist, so this is a payload-size and shape problem, not a missing-index problem.

## The fix

1. Split the RPC into two:
   - `get_agent_service_center_summary()` — one row per sub-agent with profile, wallet, link status, commission/bonus totals, and the counts only (tenants, landlords, houses, pending states, pending transfers). No embedded lists.
   - `get_agent_subagent_detail(p_sub_agent_id)` — returns the tenant, landlord and house lists for a single sub-agent, called only when that sub-agent's detail sheet opens.
2. Point the roster page at the summary RPC so the first paint needs a small response; `SubAgentDetailSheet` and the suspend/transfer/unlink dialogs read from the new per-sub-agent detail query.
3. Recompute the one page-level total that currently needs `tenant_list` (`tenantsPending`) inside the summary RPC as a count, so the page no longer depends on the lists at all.
4. Prefetch: on tapping the Service Center button, warm the summary query so the data is often already in cache by the time the lazy route chunk mounts.
5. Render progressively — header, KPI row and tabs paint immediately; only the roster list area shows skeletons, and the vetting-queue tabs load independently instead of holding up the roster.
6. Cap detail payloads server-side (most recent N houses/landlords/tenants per sub-agent, with a "show more" path) so a sub-agent with thousands of listings can never stall the sheet.

## Technical notes

- New migration adds the two functions with `SECURITY DEFINER`, `STABLE`, `SET search_path = public`, keeping the existing `auth.uid()` parent check; `EXECUTE` granted to `authenticated`.
- The old `get_agent_service_center()` stays in place until the UI is switched over, then is dropped in a follow-up so nothing breaks mid-deploy.
- Files touched: `src/hooks/useAgentServiceCenter.ts` (split queries + a `useSubAgentDetail(id)` hook), `src/pages/AgentServiceCenter.tsx`, `src/components/agent/service-center/SubAgentDetailSheet.tsx`, `SubAgentActionDialogs.tsx`, and the tap handler in `src/components/dashboards/AgentDashboard.tsx` for prefetch.
- No change to the "New" badge markup and no change to vetting/transfer business logic.
