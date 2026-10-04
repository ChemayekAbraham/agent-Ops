---
name: No client cache-recovery / forced-update system
description: The iOS forced-update, cache-recovery, version-gate and staged-rollout machinery was deleted; never reintroduce service workers, version.json, recovery counters, forced-update overlays, or URL cache-busters
type: constraint
---
On 2026-06-01 the entire client-side cache-recovery / forced-update system was
removed at the user's request because it caused iPhone refresh loops and stale
"Clearing old iPhone cache" / "Update Required" screens.

**Deleted (do not bring back):**
- `src/lib/forcedUpdate.ts`, `src/lib/hardRecovery.ts`, `src/lib/iosFreshness.ts`,
  `src/lib/versionGate.ts`, `src/lib/rollout.ts`, `src/lib/updateTelemetry.ts`,
  `src/lib/updateDebugLog.ts`
- `src/hooks/useServiceWorkerUpdate.ts`, `src/hooks/useForceRefresh.ts`,
  `src/hooks/useIOSCacheInvalidation.ts`
- `src/components/UpdateAvailableToast.tsx`, `src/pages/Diagnostics.tsx` (+ `/diagnostics` route)
- `public/sw.js`, `public/service-worker.js`, `public/version.json`
- Retired edge function `wallet-deduction`

**Rules going forward:**
- No service workers, no `version.json` polling, no recovery-attempt counters,
  no forced-update/version-gate overlays, no URL cache-busters (`?_v=`, timestamps).
- App freshness relies solely on the Lovable proxy serving HTML `no-cache`
  (browser revalidates on every navigation).
- Chunk/import errors recover via a plain `window.location.reload()` — see
  `main.tsx`, `App.tsx`, `ChunkErrorBoundary.tsx`.
- The DB tables `mobile_rollout_config` and `update_failure_events` still exist
  but are unused; their only remaining references are in auto-generated
  `src/integrations/supabase/types.ts`.
- Genuine iOS UX helpers (`IOSOptimizations`, `IOSLinkHandler`, `IOSShareReceiver`)
  are NOT part of this system and remain in use.

**Why:** programmatic reloads + URL busters could never beat iOS Safari's cached
document; the recovery loop trapped devices. Removing it makes recovery a normal
network revalidation.