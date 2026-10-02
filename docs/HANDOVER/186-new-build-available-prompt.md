# 186 — Tell open tabs when a newer build is live (monitor error #1)

## Status
**BUILT 2026-10-02, frontend only.** `src/lib/buildUpdate.ts` (+ test, 5 pass), `src/components/BuildUpdateWatcher.tsx`, one mount line + import in `src/App.tsx`. No migration, no edge function.

## The error this closes
Agent Collections monitor, live 2026-10-02. Everything left in the app source of the error log is a tab running an old bundle:
- `Cannot read properties of undefined (reading 'AgentTenantsSheet' / 'AgentListingsSheet' / 'AgentMenuDrawer' / 'AgentLandlordFloatAllocationsDialog')`: the stacks name `AgentDashboard-*.js` chunks that now return HTTP 404 (checked: `BGuwFRV2`, `D9GVJjve`, `D1TJjgH2`). `lazyNamed` (09-30 15:54 UTC) already handles this in current code; an old tab never gets it.
- The `fieldCollectStore` IndexedDB rows (83 from one tab on 09-30) were the same story (doc 176 correction, doc 178).
Since the 07:29 UTC build on 10-01 there were only a few such rows, all from old tabs. No tab ever learned a new build existed: `/version.json` returns 404 and nothing read it.

## Change
`BuildUpdateWatcher` (headless) compares the running build with the live `/build-info.json` (fetched uncached). It checks 30 s after load, when the tab becomes visible (at most every 5 min), and every 15 min. When the live build has a different source hash AND a later `builtAt`, it shows one persistent toast: "A new version of Welile is ready" with an "Update now" action that reloads the page.
- **Never reloads by itself.** Only the tap does.
- **Held back during protected flows**: if `isCriticalFlowActive()` (collect dialog, payout wizard, auth page), the prompt waits and appears when the flow closes. Note that guard only covers those three flows; other flows (e.g. FieldCollectDialog, withdrawals) are not registered, so the prompt can appear over them. It never acts on its own, so no work is lost unless the user taps it. The prompt says to finish first.
- **Rollback-safe**: an older live build never prompts (`isNewerBuild` needs a later `builtAt`).
- **Skips** dev and unstamped builds (`BUILD_INFO.mode !== 'production'`, `source` unknown).
- The service worker has no fetch handler (push-only), so nothing caches `/build-info.json`.

## Limits
- It only helps tabs that load THIS build or later. Tabs already on an old bundle will not have the watcher; they clear when they reload. Expect the old-chunk rows to fade over days, not instantly.
- Wording and look of the toast are Gemini's.
- A tab left backgrounded for days is only checked when it becomes visible.

## Verify
After deploy, open the site on a tab, publish a later build, return to the tab and confirm the toast appears and "Update now" loads the new build. Over the next days the `reading 'Agent…'` and IDB rows in the monitor should keep falling.

## Not fixed here (still open on the monitor)
- `reading 'target'` (vaul 0.9.9 Drawer long-press, 9 rows / 3 agents): needs a UI-library upgrade (vaul 1.1.2 adds the null guard), for Gemini.
- `Cannot destructure property 'Country'` (3 rows, 1 user): not yet traced.

## Architecture map
No update: a headless watcher, no new data flow.
