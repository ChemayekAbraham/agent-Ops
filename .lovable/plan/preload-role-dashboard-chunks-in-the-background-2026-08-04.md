# Preload role dashboard chunks in the background

## Goal
Remove the full-screen "Loading..." pause that appears when a user taps another persona (Tenant → Agent → Supporter → Landlord). Instead of fetching that persona's code only on tap, fetch it quietly after the first dashboard has finished rendering, so the switch is instant from cache.

## Feasibility: yes, and it fits the existing machinery
- `src/pages/Dashboard.tsx` already lazy-loads all five public dashboards through `lazyWithRetry`, and `src/lib/lazyWithRetry.tsx` already exposes a `queuedImport` FIFO queue with per-connection concurrency limits. Warming a chunk is just calling the same `import()` early — React reuses the resolved module, so no component or data logic changes.
- The chunks are the right size to matter: `AgentDashboard` is 2,185 lines, `ManagerDashboard` 1,232, `SupporterDashboard` 710, `TenantDashboard` 615, `LandlordDashboard` 171. Agent is the heaviest and the most switched-to, so it is the biggest win.
- Risk is contention, not correctness: on a 2G field connection, extra parallel requests are exactly what the import queue was built to prevent. So the preload must be strictly lowest-priority and skippable.

## What gets built

1. **A small preload registry** (new file, `src/lib/preloadRoleDashboards.ts`)
   - One map from public role → the same `import()` factory used in `Dashboard.tsx`.
   - `preloadRole(role)` runs the factory through `queuedImport`, remembers what it already warmed, and swallows all errors (a failed warm must never surface to the user — the real lazy load will retry on tap).
   - Serial, one chunk at a time, never parallel.

2. **Idle-time warming after first paint** (edit `src/pages/Dashboard.tsx`)
   - After the active dashboard has mounted, wait for idle (`requestIdleCallback`, with a `setTimeout` fallback for Safari) and then warm only the *other* roles the user actually holds, in switch-likelihood order.
   - Skip entirely when: `navigator.connection.saveData` is on, `effectiveType` is `2g`/`slow-2g`, or the tab is hidden.
   - Runs once per session.

3. **Warm on intent** (edit `src/components/BottomRoleSwitcher.tsx`)
   - On `pointerdown`/`touchstart` of a role pill, warm that role immediately. This covers the case where idle warming has not finished yet and gives a head start of a few hundred ms even on slow links.

4. **Executive roles (optional, same pattern)**
   - CEO/CFO/COO/CTO/CMO/CRM/HR/Operations/Manager are separate routes (`roleDashboardRoutes` in `executiveSidebarConfig.ts`), lazy-loaded as pages in `App.tsx`. If wanted, the same registry can warm the one isolated route a user holds. Kept out of the first pass to keep the change small and to avoid pulling large executive bundles onto field agents' phones.

## Expected impact
- Switching persona becomes an instant render on repeat switches and on any switch after idle warming completes, because the module is already in memory.
- Cost is one extra background request per additional role held. Most users hold one or two roles, so in practice this is a single ~one-off fetch, deferred until after the visible dashboard is done and suppressed on poor connections.
- No change to what any dashboard renders, fetches, or writes.

## Out of scope
- Data prefetching (React Query warming) — this plan only preloads code.
- The `pendingRole` full-screen spinner behaviour in `Dashboard.tsx`, which also contributes to the perceived delay. Worth a separate pass if the switch still feels abrupt after preloading.
