/**
 * Single source of truth for canonical + legacy domains used by CI guards
 * and the sitemap generator. Values come from environment variables so each
 * deployment (production, staging, preview forks, self-hosted) can override
 * them without patching guard scripts.
 *
 *   SITE_CANONICAL_DOMAIN   default: welileapp.com
 *   SITE_CANONICAL_ORIGIN   default: https://<SITE_CANONICAL_DOMAIN>
 *   SITE_LEGACY_DOMAINS     comma-separated hostnames that must never appear
 *                           in shipping code (default: welilereceipts.com,
 *                           welilereciept.com, welilereceipts-com.lovable.app)
 *   SITE_LEGACY_ORIGIN      default: https://<first SITE_LEGACY_DOMAINS entry>
 *                           (used by generate-sitemap.ts for the 301 sitemap)
 */

function trim(v) {
  return typeof v === 'string' ? v.trim() : '';
}

export const CANONICAL_DOMAIN =
  trim(process.env.SITE_CANONICAL_DOMAIN) || 'welileapp.com';

export const CANONICAL_ORIGIN =
  trim(process.env.SITE_CANONICAL_ORIGIN) || `https://${CANONICAL_DOMAIN}`;

// NOTE: order matters — LEGACY_ORIGIN below uses the FIRST entry as the base
// for the 301 sitemap, so a fully retired host must never sit at index 0.
// welile.tech is retired: it is listed here ONLY so guard-legacy-domain.mjs
// keeps rejecting it in shipping code. Nothing may emit URLs on it.
const DEFAULT_LEGACY = [
  'welilereceipts.com',
  'welilereciept.com',
  'welilereceipts-com.lovable.app',
  'welile.tech', // retired host — blocked, never emitted
];

export const LEGACY_DOMAINS = (
  trim(process.env.SITE_LEGACY_DOMAINS)
    ? process.env.SITE_LEGACY_DOMAINS.split(',')
    : DEFAULT_LEGACY
)
  .map((s) => s.trim())
  .filter(Boolean);

export const LEGACY_ORIGIN =
  trim(process.env.SITE_LEGACY_ORIGIN) ||
  (LEGACY_DOMAINS[0] ? `https://${LEGACY_DOMAINS[0]}` : '');

function escapeForRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the regex used by guard-legacy-domain.mjs to detect legacy hostnames
 * in shipping source. Handles optional `www.` prefixes for bare hostnames,
 * and matches lovable staging subdomains verbatim.
 */
export function buildLegacyDomainRegex() {
  const parts = LEGACY_DOMAINS.map((host) => {
    const escaped = escapeForRegex(host);
    // Bare `foo.com` gets an optional `www.` prefix; already-qualified
    // subdomains (anything with more than one dot) match verbatim.
    const isBare = host.split('.').length === 2;
    return isBare ? `(?:www\\.)?${escaped}` : escaped;
  });
  return new RegExp(`\\b(?:${parts.join('|')})\\b`, 'i');
}