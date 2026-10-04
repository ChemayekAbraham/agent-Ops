# 179 — Dashboard offline branch crashed on a null user

## Status
**BUILT 2026-10-01, not yet deployed.** Frontend only (`src/pages/Dashboard.tsx`). No migration, no edge function.

## Symptom
Agent Collections monitor (doc 178) showed `Cannot read properties of null (reading 'id')` from the `TenantDashboard` chunk, caught by `DashboardErrorBoundary`, on route `/dashboard/agent`. 6 rows in 14 days, newest 2026-10-01 04:12 UTC, Android WebViews.

## Cause (read from code, not reproduced)
`Dashboard.tsx` had an offline-with-cached-roles branch (`loading && !isOnline && cachedRoles.length > 0`) that passed `user: user!` to the dashboards. `user` is still null while the session restores, and `TenantDashboard` reads `user.id` on its first render (`tenant_dashboard_${user.id}`, `user.id` effect deps). The branch also always picked `cachedRoles[0]`, ignoring the URL, so an agent on `/dashboard/agent` whose first cached role was `tenant` was shown the tenant dashboard. That explains why a tenant chunk crashed on an agent route.

## Change
- The branch now requires `user`; otherwise it falls through to the existing loader (`DashboardLoadingFallback`).
- The displayed role is the URL role when it is among the cached roles, else `cachedRoles[0]` as before.
- `user!` removed.

## Confidence
Moderate. The stack points at `user.id` in `TenantDashboard`, and this is the only path that renders it with a possibly-null user, but I did not reproduce it. Check that `reading 'id'` rows from `TenantDashboard` stop after deploy.

## Other small error clusters checked (no change)
- `Write permission denied.` (9 rows, 1 agent): fixed by doc 160 on 2026-09-29 14:26 UTC; 0 since.
- `reading 'target'` (8 rows, 3 agents, newest 09-26): a library `onContextMenu` handler in `vendor-common` receiving a null event on Android 10 long-press. No repo handler reads `e.target`; left alone.
- `reading 'replace'` (2 rows, newest 09-17): stale.

## Architecture map
No update: a guard inside an existing page.
