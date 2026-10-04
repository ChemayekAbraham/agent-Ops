// Runs before `vite dev` and `vite build` (predev/prebuild hooks); writes public/sitemap.xml.
// Includes static marketing routes AND one entry per live, photographed house listing
// so individual /house/:id pages are discoverable by Google.

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Domains come from scripts/site-domains.mjs (env-configurable per deployment).
// @ts-expect-error — plain .mjs sibling with no bundled type declarations.
import { CANONICAL_ORIGIN, LEGACY_ORIGIN } from './site-domains.mjs';

const BASE_URL = CANONICAL_ORIGIN;
// Legacy domain being consolidated into BASE_URL via 301 redirects. A
// dedicated sitemap of these URLs helps Google recrawl the old domain,
// discover each 301, and transfer signals to the canonical pages.
const LEGACY_BASE_URL = LEGACY_ORIGIN;

interface SitemapEntry {
  path: string;
  lastmod?: string;
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority?: string;
}

// Static, indexable marketing/public routes.
// Deliberately excluded (and Disallowed in public/robots.txt): signed-in
// dashboards (/dashboard, /dashboard/tenant), referral redirect links
// (/r/:code) and personal Welile AI ID profiles (/profile/:aiId, /id/:aiId).
// These are per-user, auth-gated or redirect-only with no indexable content.
const staticEntries: SitemapEntry[] = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/welcome', changefreq: 'weekly', priority: '0.95' },
  { path: '/find-a-house', changefreq: 'daily', priority: '0.95' },
  // Location landing pages — high-intent Google queries like
  // "houses for rent in Kampala". Keep this list in sync with
  // REGION_LANDING_SLUGS in src/pages/FindAHouse.tsx.
  { path: '/find-a-house/kampala', changefreq: 'daily', priority: '0.9' },
  { path: '/find-a-house/wakiso', changefreq: 'daily', priority: '0.9' },
  { path: '/find-a-house/mukono', changefreq: 'daily', priority: '0.85' },
  { path: '/find-a-house/jinja', changefreq: 'daily', priority: '0.85' },
  { path: '/find-a-house/mbale', changefreq: 'daily', priority: '0.8' },
  { path: '/find-a-house/mbarara', changefreq: 'daily', priority: '0.8' },
  { path: '/find-a-house/gulu', changefreq: 'daily', priority: '0.8' },
  { path: '/find-a-house/lira', changefreq: 'daily', priority: '0.75' },
  { path: '/find-a-house/fort-portal', changefreq: 'daily', priority: '0.75' },
  { path: '/find-a-house/masaka', changefreq: 'daily', priority: '0.75' },
  { path: '/find-a-house/entebbe', changefreq: 'daily', priority: '0.85' },
  { path: '/find-a-house/nansana', changefreq: 'daily', priority: '0.85' },
  { path: '/find-a-house/kira', changefreq: 'daily', priority: '0.85' },
  { path: '/find-a-house/bweyogerere', changefreq: 'daily', priority: '0.8' },
  { path: '/find-a-house/central', changefreq: 'weekly', priority: '0.7' },
  { path: '/find-a-house/eastern', changefreq: 'weekly', priority: '0.7' },
  { path: '/find-a-house/northern', changefreq: 'weekly', priority: '0.7' },
  { path: '/find-a-house/western', changefreq: 'weekly', priority: '0.7' },
  { path: '/rent-money', changefreq: 'weekly', priority: '0.9' },
  { path: '/become-supporter', changefreq: 'weekly', priority: '0.8' },
  { path: '/funder-onboarding', changefreq: 'weekly', priority: '0.8' },
  { path: '/partner-onboarding', changefreq: 'weekly', priority: '0.7' },
  { path: '/opportunities', changefreq: 'weekly', priority: '0.7' },
  { path: '/join', changefreq: 'weekly', priority: '0.7' },
  { path: '/internship', changefreq: 'monthly', priority: '0.6' },
  { path: '/careers', changefreq: 'weekly', priority: '0.6' },
  { path: '/landlord-signup', changefreq: 'weekly', priority: '0.7' },
  { path: '/rent-calculator', changefreq: 'monthly', priority: '0.7' },
  { path: '/guides/pay-rent-in-installments-uganda', changefreq: 'monthly', priority: '0.7' },
  // Cost-of-renting city guides
  { path: '/guides/cost-of-renting', changefreq: 'weekly', priority: '0.7' },
  { path: '/guides/cost-of-renting-in-kampala', changefreq: 'monthly', priority: '0.85' },
  { path: '/guides/cost-of-renting-in-wakiso', changefreq: 'monthly', priority: '0.8' },
  { path: '/guides/cost-of-renting-in-entebbe', changefreq: 'monthly', priority: '0.8' },
  { path: '/guides/cost-of-renting-in-jinja', changefreq: 'monthly', priority: '0.8' },
  { path: '/guides/cost-of-renting-in-mbarara', changefreq: 'monthly', priority: '0.75' },
  { path: '/guides/cost-of-renting-in-gulu', changefreq: 'monthly', priority: '0.75' },
  { path: '/guides/cost-of-renting-in-mukono', changefreq: 'monthly', priority: '0.75' },
  { path: '/guides/cost-of-renting-in-nansana', changefreq: 'monthly', priority: '0.75' },
  // Neighbourhood comparisons
  { path: '/guides/compare', changefreq: 'weekly', priority: '0.7' },
  { path: '/guides/compare/ntinda-vs-bukoto', changefreq: 'monthly', priority: '0.8' },
  { path: '/guides/compare/kira-vs-najjera', changefreq: 'monthly', priority: '0.75' },
  { path: '/guides/compare/muyenga-vs-bugolobi', changefreq: 'monthly', priority: '0.75' },
  { path: '/guides/compare/bukoto-vs-kamwokya', changefreq: 'monthly', priority: '0.75' },
  { path: '/guides/compare/ntinda-vs-naalya', changefreq: 'monthly', priority: '0.75' },
  { path: '/guides/compare/kansanga-vs-muyenga', changefreq: 'monthly', priority: '0.75' },
  { path: '/ai', changefreq: 'weekly', priority: '0.7' },
  { path: '/terms', changefreq: 'monthly', priority: '0.3' },
  { path: '/privacy', changefreq: 'monthly', priority: '0.3' },
  { path: '/auth', changefreq: 'monthly', priority: '0.4' },
  { path: '/onboarding', changefreq: 'monthly', priority: '0.4' },
  { path: '/unsubscribe', changefreq: 'yearly', priority: '0.2' },
  { path: '/stop-sms', changefreq: 'yearly', priority: '0.2' },
  { path: '/resume-sms', changefreq: 'yearly', priority: '0.2' },
];

/** Minimal .env reader so the standalone script picks up Supabase creds. */
function readEnv(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  const envPath = resolve('.env');
  if (!existsSync(envPath)) return undefined;
  const line = readFileSync(envPath, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${key}=`));
  if (!line) return undefined;
  return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] as string),
  );
}

async function fetchLiveHouses(): Promise<SitemapEntry[]> {
  const url = readEnv('VITE_SUPABASE_URL');
  const key = readEnv('VITE_SUPABASE_PUBLISHABLE_KEY');
  if (!url || !key) {
    console.warn('sitemap: Supabase env missing — skipping house listings');
    return [];
  }
  // Same public-visibility filters as PublicHousesPreview: available, not hidden,
  // not yet tenanted, has photos. Select id, short_code, updated_at.
  const endpoint =
    `${url}/rest/v1/house_listings` +
    `?select=id,short_code,updated_at,image_urls` +
    `&status=eq.available&is_hidden=eq.false&tenant_id=is.null` +
    `&image_urls=not.is.null&order=updated_at.desc&limit=5000`;
  try {
    const res = await fetch(endpoint, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      console.warn(`sitemap: house fetch failed (${res.status}) — skipping`);
      return [];
    }
    const rows = (await res.json()) as Array<{
      id: string;
      short_code: string | null;
      updated_at: string | null;
      image_urls: string[] | null;
    }>;
    return rows
      .filter((r) => Array.isArray(r.image_urls) && r.image_urls.some((u) => typeof u === 'string' && u.trim().length > 0))
      .map((r) => ({
        path: `/house/${r.short_code || r.id}`,
        lastmod: r.updated_at ? r.updated_at.slice(0, 10) : undefined,
        changefreq: 'weekly' as const,
        priority: '0.8',
      }));
  } catch (err) {
    console.warn('sitemap: house fetch error — skipping', err);
    return [];
  }
}

function generateSitemap(entries: SitemapEntry[], baseUrl: string = BASE_URL) {
  const urls = entries.map((e) =>
    [
      '  <url>',
      `    <loc>${baseUrl}${xmlEscape(e.path)}</loc>`,
      e.lastmod ? `    <lastmod>${e.lastmod}</lastmod>` : null,
      e.changefreq ? `    <changefreq>${e.changefreq}</changefreq>` : null,
      e.priority ? `    <priority>${e.priority}</priority>` : null,
      '  </url>',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
  ].join('\n');
}

async function main() {
  const houses = await fetchLiveHouses();
  const entries = [...staticEntries, ...houses];
  writeFileSync(resolve('public/sitemap.xml'), generateSitemap(entries));
  console.log(`sitemap.xml written (${entries.length} entries, ${houses.length} houses)`);

  // Legacy-domain sitemap: same paths on the legacy host (welilereceipts.com) so Google recrawls
  // them and picks up the 301 redirects to their canonical welileapp.com targets.
  writeFileSync(
    resolve('public/sitemap-welilereceipts.xml'),
    generateSitemap(entries, LEGACY_BASE_URL),
  );
  console.log(`sitemap-welilereceipts.xml written (${entries.length} entries, base ${LEGACY_BASE_URL})`);
}

main();
