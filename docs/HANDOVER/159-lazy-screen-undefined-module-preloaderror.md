# 159. Agent screens crashing with "Cannot read properties of undefined (reading 'AgentTenantsSheet')" (2026-09-29)

**Status:** Fixed in code 2026-09-29, frontend only. Goes live on the next Lovable publish.
**This is issue #3** from the Agent Collections Monitor pass (doc 158).
**Read before touching:** the `vite:preloadError` listener in `src/main.tsx`, or `src/lib/lazyWithRetry.ts`.

## Symptom

`client_error_reports` rows with `source: dashboard-error-boundary` on `/dashboard/agent`, e.g.
`Cannot read properties of undefined (reading 'AgentTenantsSheet')`. The same error has appeared with
`SendMoneyDialog`, `FullScreenWalletSheet`, `AgentMenuDrawer`, `ListEmptyHouseDialog`,
`AgentPromissoryNotesList`, `AgentCashPayoutsTab` and others. That's about 1–4 a day from different agents, mostly Android Chrome, on
many different `AgentDashboard-*.js` bundle hashes. Doc 151 had filed this as "stale bundle, Gemini's". It is not a JSX
problem.

## Root cause

`src/main.tsx` had `addEventListener('vite:preloadError', e => e.preventDefault())`. In Vite 5.4
the preload helper is:

```js
return promise.then(res => { /* css preload failures -> handlePreloadError */
  return baseModule().catch(handlePreloadError); });
// handlePreloadError: dispatch 'vite:preloadError'; if (!e.defaultPrevented) throw err;
```

When the actual JS chunk fails (a stale hash after a deploy, or a dropped request on a field network),
the prevented event makes `import()` **resolve with `undefined`**. The wrapper
`import(...).then(m => ({ default: m.AgentTenantsSheet }))` then throws the TypeError above.
`lazyWithRetry` retried against the browser's cached failed module, forced its one-time reload, and then
**threw**. The dashboard error boundary caught that throw, flashed the crash screen and filed a
report while the page was already reloading.

## Fix

- `src/main.tsx`: `preventDefault` only when the payload is `Unable to preload CSS …`, which is the
  one case where the JS still loads. A failed JS import now rejects with its real error.
- `src/lib/lazyWithRetry.ts`: when the one-time reload has been triggered, return a never-resolving
  promise instead of throwing. Suspense keeps its spinner until the reload takes over, so there's no crash
  screen and no false error report. The explicit "This screen needs to reload" card
  (reload already spent in the last 30 s) is unchanged.

## Verify after publish

New rows matching `Cannot read properties of undefined (reading '%')` from
`dashboard-error-boundary` should stop. Genuine repeated chunk failures now show up as the
"This screen needs to reload" card rather than a report.
