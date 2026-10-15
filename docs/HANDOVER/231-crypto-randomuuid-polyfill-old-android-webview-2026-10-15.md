# 231 — `crypto.randomUUID is not a function` on old Android WebViews (2026-10-15)

**Status:** code committed on `dev/cto-report-sms-balance-watch`; not yet merged to `lovable` or deployed.

## Symptom
`agent-collection-errors-all-7d-20261015-0921.csv`: 165 of 173 rows were `crypto.randomUUID is not a function` (warning, `client`). All from **one agent, one device** (Android 11, SM-A107F WebView), 2026-10-12 → 10-14, on `/dashboard/agent/proxy/notes` (125), `/houses` (37) and `/proxy` (3). The count is one retry loop, not 165 users.

## Cause
`crypto.randomUUID` is missing before Chrome 92. The stack is an async function in the main `index-*.js` chunk. No page code on those routes calls it; the call came from a shared or stale chunk. `safeUUID()` (doc history: 10-08..10-10) already covers the app-code callers, but nothing patched the global for everything else.

## Fix
- `src/lib/polyfills/crypto-randomuuid.ts` + probe in `src/lib/runtimePolyfills.ts`: the polyfill gate now installs `crypto.randomUUID` (via `getRandomValues`) only on devices that lack it. Modern phones fetch nothing.
- `FoodOrderingPage.tsx` and `foodService.ts`: the last two raw `crypto.randomUUID()` calls in app code now use `safeUUID()`.

## Verify
After deploy, the `randomUUID` rows should stop. If that device still reports it, it is on a stale cached bundle (`index-D033NzcQ`) and needs a reload.

## Not fixed here (separate issues in the same CSV)
`Failed to fetch` / `Load failed` on allocate (2), statement timeout 57014 on allocate (2), lazy-chunk `reading 'AgentTenantsSheet'` style errors (3), `t.preview` TypeError in AgentRentRequestDialog (1).
