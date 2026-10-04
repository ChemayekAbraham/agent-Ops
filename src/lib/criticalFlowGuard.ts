/**
 * Critical-flow guard.
 *
 * iOS Safari (especially in standalone/PWA mode) aggressively backgrounds
 * the tab whenever the user dips into another app — Mobile Money USSD,
 * Messages for an OTP, the SIM toolkit, the camera. When they come back,
 * `useIOSCacheInvalidation` would normally invalidate every React Query
 * AND ping the service worker to skipWaiting, which visually looks like
 * "the app refreshed and lost my work".
 *
 * Any UI flow that must survive a background-and-return round trip
 * (agent → tenant payment, MoMo OTP entry, withdrawal approval, etc.)
 * registers itself here while it is open. The cache-invalidation hook
 * and the SW update flow check `isCriticalFlowActive()` and stand down.
 *
 * IMPORTANT: this never touches wallet balances, ledger entries, or any
 * mutation payload. It only controls *client-side cache churn*.
 */

const active = new Set<string>();
const listeners = new Set<() => void>();

export function setCriticalFlowActive(key: string, on: boolean): void {
  const had = active.has(key);
  if (on) active.add(key);
  else active.delete(key);
  if (had !== active.has(key)) listeners.forEach((l) => l());
}

export function isCriticalFlowActive(): boolean {
  return active.size > 0;
}

export function subscribeCriticalFlow(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
