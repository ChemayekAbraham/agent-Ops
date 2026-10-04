/**
 * The single canonical public origin for every generated/shared link.
 * Overridable per deployment via `VITE_CANONICAL_ORIGIN` (baked in at build
 * time by Vite). Falls back to the production origin.
 */
export const CANONICAL_ORIGIN: string =
  (import.meta.env?.VITE_CANONICAL_ORIGIN as string | undefined)?.trim() ||
  'https://welileapp.com';

/**
 * Returns the canonical public-facing origin for share/referral/invite links.
 *
 * Always resolves to https://welileapp.com on every real host — preview
 * (*.lovable.app), published, the www. subdomain, and the apex custom domain —
 * so shared links never leak a Lovable-auth-gated URL or a www/legacy variant.
 * Only true local development (localhost / 127.0.0.1) keeps its own origin so
 * devs can test generated links locally.
 */
export function getPublicOrigin(): string {
  if (typeof window === 'undefined') return CANONICAL_ORIGIN;
  const hostname = window.location.hostname;
  const isLocalDev =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname.endsWith('.local');
  return isLocalDev ? window.location.origin : CANONICAL_ORIGIN;
}
