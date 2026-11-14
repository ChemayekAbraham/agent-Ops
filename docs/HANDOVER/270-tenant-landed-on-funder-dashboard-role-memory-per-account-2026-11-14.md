# 270 — A tenant signed in and landed on the funder dashboard

**Date:** 2026-11-14 · **Asked by:** Josh (CTO) · **Status:** code change on `dev/financial-ops`, tests pass, **NOT PUSHED, NOT LIVE.** Frontend only: no migration, no edge function.

## What was asked

The CTO signed in as a brand-new test tenant (0761658253, account `89c0a06f-d243-4099-a97c-d710e2885e61`, sign-up role `tenant`) and was sent to the funder (supporter) dashboard. Why?

## What was found

The account itself was correct: `intended_role = tenant`, no `forced_default_role`. Two client-side causes, both about the browser rather than the person:

1. **Every returning visitor started as `supporter`.** `useAuth` built its starting role as "supporter if the cached role list contains supporter", and `initialRoles` adds supporter to any cached list. The role lookup (`fetchUserRoles`) was then handed that starting role as the "current" role and **kept it whenever the account holds it**. Every new account gets all four roles (tenant, agent, landlord, supporter), so a tenant opening the app with any role cache was kept on supporter, and `DashboardRedirect`'s fallback sent them to `/dashboard/funder`. The account's own sign-up role, last role and tenant-first fallback never ran.
2. **Role memory was per browser, not per account.** `welile_last_role` and the Settings "home screen" (`welile_app_preferences.defaultRole`, `disableAgentAutoDefault`) were single values per browser. Phones are shared: 98% of rent requests come through agents, who often sign tenants in on the agent's own phone. The next person to sign in inherited the previous person's dashboard.

Supporting signal: in the CMO web analytics (13–20 Aug) `/dashboard/funder` had 2,182 visitors against 1,104 for `/dashboard/tenant`, although supporters are a small group.

## Fix

- `src/lib/roleMemory.ts` (new): the last role is stored as `welile_last_role:<account id>`; the old shared key is ignored and removed on the next write. Holds the tenant-first fallback `pickFallbackRole`.
- `useAuth`: the starting role is this account's own last role, else tenant-first (never supporter-first). A new `chosenRoleRef` holds only a role the person picked this session (`switchRole`, `grantAndSwitchRole`); that, not the placeholder, is what the role lookup receives as "current". Cleared on sign-out.
- `roleManager`: the landing decision is now the pure `chooseLandingRole` (admin-forced → this account's home screen → merchant-agent rule → this account's last role → sign-up role → tenant-first). Reads the per-account last role.
- `useAppPreferences`: routing prefs carry `routingOwner`. `getPreferredDefaultRole(userId)` and `isAgentAutoDefaultDisabled(userId)` ignore prefs saved by another account (or saved before owners were recorded). On load, another account's prefs are replaced by this account's server copy (`profiles.routing_preferences`) or the defaults.
- `DashboardRedirect`, `Dashboard`, `Index`: pass the account id; local prefs count only when owned, otherwise the account's server copy is used.

Effect for existing users: a home screen chosen in Settings before today is ignored on the device until it is re-read from the server copy (`profiles.routing_preferences`), which every Settings change already mirrors, so it comes back on the next load. A last role from before today is forgotten once; people land on their sign-up role or tenant-first until they switch.

## Tested

- New: `src/lib/roleMemory.test.ts` (4), `src/hooks/useAppPreferences.owner.test.ts` (4), `chooseLandingRole` in `src/hooks/auth/roleManager.test.ts` (6), and a shared-phone case in `DashboardRedirect.test.tsx` (another account's saved choice is ignored; this account's server choice wins).
- `IndexProxyLanding.test.tsx`: its saved home screen now carries the test account as owner.
- `vitest related` on the changed files: the remaining failures (RoleGating "Funder" tab, Food, Zoe, SendMoney, RoleGuard and others, 36 files) fail the same way on the code before this change. Two slow tests that failed only under load pass alone.
- Not verified in a browser: signing in needs the test account's password.

## Not changed

The roles cache (`welile_roles_cache`) is still per browser; it only seeds the role list until the database answers and no longer decides the landing page.
