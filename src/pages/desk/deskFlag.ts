/**
 * VITE_DESK_CHECKLIST — the E26 review drawer, the COO funding plan, the funder
 * board preview and the pipeline cards on the command centre.
 *
 * Why this is not `import.meta.env.PROD`
 * --------------------------------------
 * Vite replaces `import.meta.env.*` at BUILD time, and the Lovable preview is
 * built the same way production is — `vite build`, `PROD === true`, the same
 * bundle. So neither `PROD` nor the variable on its own can tell the preview
 * apart from welileapp.com. The host at RUNTIME is the only thing that differs,
 * so that is what decides.
 *
 * The rule, in order:
 *
 *   1. VITE_DESK_CHECKLIST is set to true/1/on   → on, on every host.
 *      VITE_DESK_CHECKLIST is set to false/0/off → off, on every host.
 *      This is the switch Mark flips to open it on production.
 *   2. The variable is unset (today) → the host decides:
 *        on   localhost / 127.0.0.1 / *.local               (development)
 *        on   *.lovableproject.com, id-preview--*, preview--* (Lovable preview)
 *        off  welileapp.com and www.welileapp.com            (production)
 *        off  *.lovable.app published, and any host not named above
 *
 * Unknown hosts fail closed, so production can only ever turn on by someone
 * deliberately setting the variable. Host detection matches `isPreviewHost` in
 * `src/hooks/auth/authOperations.ts` and `detectEnv` in `EnvironmentBanner`.
 */

/** An explicit variable wins everywhere. Undefined when it is not set. */
function envOverride(): boolean | undefined {
  const v = ((import.meta.env.VITE_DESK_CHECKLIST as string | undefined) ?? '').trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'off') return false;
  return undefined;
}

/** Development and Lovable preview hosts only — everything else is off. */
export function isCheckListHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const local = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.endsWith('.local');
  const preview =
    host.includes('id-preview--') || host.includes('preview--') || host.endsWith('.lovableproject.com');
  return local || preview;
}

/**
 * Read at call time, never cached at import, so a prerender or a test can run
 * without a window. No window means no host to trust: off.
 */
export function deskChecklistOn(hostname?: string): boolean {
  const override = envOverride();
  if (override !== undefined) return override;
  const host = hostname ?? (typeof window === 'undefined' ? '' : window.location.hostname);
  if (!host) return false;
  return isCheckListHost(host);
}
