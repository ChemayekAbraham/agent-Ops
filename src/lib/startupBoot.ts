/**
 * Decisions for the pre-React boot in `src/main.tsx`.
 *
 * Kept free of DOM so the host gate and the "reload once" rule can be tested
 * without booting the app. Reporting stays on the real public hosts; Lovable
 * previews and localhost were ~95% of `startup-timeout-slow` rows and are not
 * user-facing production failures.
 */

const PRODUCTION_HOSTS = new Set([
  'welileapp.com',
  'www.welileapp.com',
  'welilereceipts.com',
  'www.welilereceipts.com',
]);

export function isProductionStartupHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  return PRODUCTION_HOSTS.has(host);
}

/**
 * Module-load failures that a single cache-busting reload can clear:
 * a rotated `App-*.js` after deploy, a stalled fetch, or WebKit's
 * "Importing a module script failed" inside an installed PWA.
 * A thrown application error is not in this set — reloading would hide it.
 */
export function isRecoverableBootFailure(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : error == null ? '' : String(error)
  ).toLowerCase();
  if (!message) return false;
  return (
    message.includes('import timeout') ||
    message.includes('failed to fetch') ||
    message.includes('dynamically imported') ||
    message.includes('importing a module script failed') ||
    message.includes('error loading dynamically imported module') ||
    message.includes('module script failed') ||
    message.includes('unable to preload css')
  );
}

/** sessionStorage key. One recovery per minute, so a hard failure can surface. */
export const BOOT_RECOVERY_KEY = 'welile-startup-recover-at';
export const BOOT_RECOVERY_COOLDOWN_MS = 60_000;

export function bootRecoveryAllowed(lastAttemptAt: number, now: number): boolean {
  if (!Number.isFinite(lastAttemptAt) || lastAttemptAt <= 0) return true;
  return now - lastAttemptAt >= BOOT_RECOVERY_COOLDOWN_MS;
}
