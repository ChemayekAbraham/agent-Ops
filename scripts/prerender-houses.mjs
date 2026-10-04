#!/usr/bin/env node
/**
 * Build-time prerendering for /house/:slug pages.
 *
 * Why:
 *   WhatsApp / Facebook / LinkedIn / Slack link scrapers do NOT execute JS,
 *   so they never see the react-helmet tags injected by HouseDetail.tsx —
 *   they only see the static <head> in dist/index.html. Without per-listing
 *   OG tags, every shared listing shows the same generic Welile preview.
 *
 * How:
 *   After `vite build`, fetch every currently-published, photographed house
 *   listing from Supabase (same filter as the sitemap generator), then for
 *   each listing write dist/house/<slug>/index.html — a copy of the built
 *   dist/index.html with the sitewide OG / twitter / canonical tags stripped
 *   and replaced by listing-specific ones plus JSON-LD (Accommodation +
 *   BreadcrumbList). We write exactly ONE shell per listing, for the
 *   canonical slug (short_code when present, otherwise uuid) — the same URL
 *   the sitemap and the canonical tag advertise. Other URL shapes still
 *   resolve through the SPA fallback.
 *
 *   The SPA still boots normally inside these files — users get the full
 *   React experience, scrapers get real per-listing metadata on first byte.
 *
 * Mirrors the head produced by src/pages/HouseDetail.tsx (SEO block ~L365-390).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { copyFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';

const BASE_URL = 'https://welileapp.com';
const DIST = resolve('dist');
const TEMPLATE_PATH = resolve(DIST, 'index.html');
// Persist across builds (dist/ is wiped every `vite build`). node_modules/.cache
// is a conventional per-project scratch space that survives builds but is
// gitignored and safe to blow away.
const CACHE_DIR = resolve('node_modules/.cache/prerender-houses');
const CACHE_SHELLS = resolve(CACHE_DIR, 'shells');
const CACHE_MANIFEST = resolve(CACHE_DIR, 'manifest.json');
const FORCE = process.env.PRERENDER_FORCE === '1' || process.argv.includes('--force');

const CATEGORY_LABELS = {
  single_room: 'Single Room',
  double_room: 'Double Room',
  bedsitter: 'Bedsitter',
  one_bedroom: '1 Bedroom',
  two_bedroom: '2 Bedrooms',
  three_bedroom: '3 Bedrooms',
  studio: 'Studio',
  shop: 'Shop',
};

function readEnv(key) {
  if (process.env[key]) return process.env[key];
  const envPath = resolve('.env');
  if (!existsSync(envPath)) return undefined;
  const line = readFileSync(envPath, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${key}=`));
  if (!line) return undefined;
  return line
    .slice(key.length + 1)
    .trim()
    .replace(/^["']|["']$/g, '');
}

function formatUGX(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'UGX 0';
  return `UGX ${Math.round(v).toLocaleString('en-US')}`;
}

function htmlEscape(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

async function fetchLiveHouses() {
  const url = readEnv('VITE_SUPABASE_URL');
  const key = readEnv('VITE_SUPABASE_PUBLISHABLE_KEY');
  if (!url || !key) {
    console.warn('prerender-houses: Supabase env missing — skipping');
    return [];
  }
  // Same public-visibility filters as the sitemap and PublicHousesPreview.
  const cols =
    'id,short_code,title,region,district,address,house_category,number_of_rooms,daily_rate,' +
    'image_urls,latitude,longitude,has_water,has_electricity,has_security,has_parking,is_furnished,updated_at';
  const endpoint =
    `${url}/rest/v1/house_listings?select=${cols}` +
    `&status=eq.available&is_hidden=eq.false&tenant_id=is.null` +
    `&image_urls=not.is.null&order=updated_at.desc&limit=5000`;
  const res = await fetch(endpoint, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    console.warn(`prerender-houses: fetch failed (${res.status}) — skipping`);
    return [];
  }
  const rows = await res.json();
  return rows.filter(
    (r) => Array.isArray(r.image_urls) && r.image_urls.some((u) => typeof u === 'string' && u.trim().length > 0),
  );
}

function buildHead(listing) {
  const slug = listing.short_code || listing.id;
  const shareUrl = `${BASE_URL}/house/${slug}`;
  const ogLocation = [listing.region, listing.district].filter(Boolean).join(', ');
  const roomWord = listing.number_of_rooms === 1 ? 'room' : 'rooms';
  const catLabel = CATEGORY_LABELS[listing.house_category] || String(listing.house_category || '').replace(/_/g, ' ');
  const ogTitle = `${listing.title} in ${listing.region} — ${formatUGX(listing.daily_rate)}/day | Welile`;
  const ogDescription =
    `${listing.title} — ${catLabel}, ${listing.number_of_rooms} ${roomWord} in ${ogLocation}. ` +
    `${formatUGX(listing.daily_rate)}/day. Pay as you stay with Welile!`;
  const ogImage = listing.image_urls?.[0] || `${BASE_URL}/og-image.png`;

  const amenityFeature = [
    listing.has_water && { '@type': 'LocationFeatureSpecification', name: 'Running Water', value: true },
    listing.has_electricity && { '@type': 'LocationFeatureSpecification', name: 'Electricity', value: true },
    listing.has_security && { '@type': 'LocationFeatureSpecification', name: 'Security', value: true },
    listing.has_parking && { '@type': 'LocationFeatureSpecification', name: 'Parking', value: true },
    listing.is_furnished && { '@type': 'LocationFeatureSpecification', name: 'Furnished', value: true },
  ].filter(Boolean);

  const houseJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Accommodation',
    name: listing.title,
    description: ogDescription,
    url: shareUrl,
    numberOfRooms: listing.number_of_rooms,
    ...(listing.image_urls?.length ? { image: listing.image_urls } : {}),
    address: {
      '@type': 'PostalAddress',
      addressLocality: listing.region,
      addressRegion: listing.district || listing.region,
      addressCountry: 'UG',
      streetAddress: listing.address,
    },
    ...(listing.latitude && listing.longitude
      ? { geo: { '@type': 'GeoCoordinates', latitude: listing.latitude, longitude: listing.longitude } }
      : {}),
    amenityFeature,
    offers: {
      '@type': 'Offer',
      price: listing.daily_rate,
      priceCurrency: 'UGX',
      availability: 'https://schema.org/InStock',
      priceValidUntil: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
      url: shareUrl,
    },
  };

  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Find a House', item: `${BASE_URL}/find-a-house` },
      { '@type': 'ListItem', position: 2, name: listing.title, item: shareUrl },
    ],
  };

  // Safe embedding in <script type="application/ld+json"> — escape closing tags.
  const jsonLdSafe = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');

  return [
    `<title>${htmlEscape(ogTitle)}</title>`,
    `<meta name="description" content="${htmlEscape(ogDescription)}" />`,
    `<link rel="canonical" href="${htmlEscape(shareUrl)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${htmlEscape(shareUrl)}" />`,
    `<meta property="og:title" content="${htmlEscape(ogTitle)}" />`,
    `<meta property="og:description" content="${htmlEscape(ogDescription)}" />`,
    `<meta property="og:image" content="${htmlEscape(ogImage)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:site_name" content="Welile" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${htmlEscape(ogTitle)}" />`,
    `<meta name="twitter:description" content="${htmlEscape(ogDescription)}" />`,
    `<meta name="twitter:image" content="${htmlEscape(ogImage)}" />`,
    `<script type="application/ld+json">${jsonLdSafe(houseJsonLd)}</script>`,
    `<script type="application/ld+json">${jsonLdSafe(breadcrumbJsonLd)}</script>`,
  ].join('\n    ');
}

/**
 * Strip the sitewide tags that per-listing tags will override. Non-JS scrapers
 * read the FIRST occurrence for OG properties, so if we leave the sitewide
 * og:title behind, previews would still be generic — remove them cleanly.
 */
function stripSitewideMeta(html) {
  const REMOVE_PATTERNS = [
    // <title> can be multi-line only in edge cases — the sitewide title is
    // single-line. Match it plainly.
    /<title>[^<]*<\/title>\s*/i,
    // The meta / link tags can be broken across lines (see the <meta name="description"...
    // block in index.html). Match across newlines and require an attribute
    // that only real tags have (href=/content=) so we skip prose examples
    // inside HTML comments.
    /<meta\s+name="description"[^>]*content=[^>]*>\s*/is,
    /<meta\s+property="og:title"[^>]*content=[^>]*>\s*/is,
    /<meta\s+property="og:description"[^>]*content=[^>]*>\s*/is,
    /<meta\s+property="og:type"[^>]*content=[^>]*>\s*/is,
    /<meta\s+property="og:image"[^>]*content=[^>]*>\s*/is,
    /<meta\s+property="og:image:width"[^>]*content=[^>]*>\s*/is,
    /<meta\s+property="og:image:height"[^>]*content=[^>]*>\s*/is,
    /<meta\s+property="og:url"[^>]*content=[^>]*>\s*/is,
    /<meta\s+name="twitter:card"[^>]*content=[^>]*>\s*/is,
    /<meta\s+name="twitter:title"[^>]*content=[^>]*>\s*/is,
    /<meta\s+name="twitter:description"[^>]*content=[^>]*>\s*/is,
    /<meta\s+name="twitter:image"[^>]*content=[^>]*>\s*/is,
    /<link\s+rel="canonical"[^>]*href=[^>]*>\s*/is,
  ];
  // Strip HTML comments from <head> that reference these tags so we don't
  // accidentally match tag-shaped strings inside them. Comments carry no SEO
  // signal, so removing them is safe.
  const commentsInHead = /<!--[\s\S]*?-->/g;
  let out = html;
  out = out.replace(/<head>[\s\S]*?<\/head>/i, (head) => head.replace(commentsInHead, ''));
  for (const re of REMOVE_PATTERNS) out = out.replace(re, '');
  return out;
}

function renderListingHtml(template, listing) {
  const stripped = stripSitewideMeta(template);
  const headBlock = buildHead(listing);
  // Inject right before </head> so all base tags load first.
  return stripped.replace(/<\/head>/i, `    ${headBlock}\n  </head>`);
}

function writeShell(slug, html) {
  const dir = resolve(DIST, 'house', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'index.html'), html);
}

function loadManifest() {
  try {
    return JSON.parse(readFileSync(CACHE_MANIFEST, 'utf8'));
  } catch {
    return { version: 1, templateHash: null, entries: {} };
  }
}

function saveManifest(m) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_MANIFEST, JSON.stringify(m, null, 2));
}

function cacheShellPath(slug) {
  return resolve(CACHE_SHELLS, `${slug}.html`);
}

function copyCachedShell(slug) {
  const src = cacheShellPath(slug);
  if (!existsSync(src)) return false;
  const dir = resolve(DIST, 'house', slug);
  mkdirSync(dir, { recursive: true });
  copyFileSync(src, resolve(dir, 'index.html'));
  return true;
}

function saveShellToCache(slug, html) {
  mkdirSync(CACHE_SHELLS, { recursive: true });
  writeFileSync(cacheShellPath(slug), html);
}

/**
 * Delete stale shells from both the cache and dist/house/ for slugs that no
 * longer belong to a currently-published listing (unlisted, taken down, or
 * excluded by the sitemap filter). Prevents WhatsApp/FB from continuing to
 * scrape stale OG tags for a listing that's gone, and keeps the cache from
 * growing unbounded over months of builds.
 *
 * `activeSlugs` is the union of every short_code + uuid we just wrote this run.
 */
function cleanupStaleShells(activeSlugs, prevEntries, nextEntries) {
  const active = new Set(activeSlugs);
  let removedCache = 0;
  let removedDist = 0;

  // 1. Cache: drop shell files for slugs (primary + aliases) no longer active.
  const knownSlugs = new Set();
  for (const e of Object.values(prevEntries)) {
    if (e && Array.isArray(e.slugs)) e.slugs.forEach((s) => knownSlugs.add(s));
  }
  for (const e of Object.values(nextEntries)) {
    if (e && Array.isArray(e.slugs)) e.slugs.forEach((s) => knownSlugs.add(s));
  }
  // Also walk the cache dir directly in case the manifest drifted.
  if (existsSync(CACHE_SHELLS)) {
    for (const file of readdirSync(CACHE_SHELLS)) {
      if (!file.endsWith('.html')) continue;
      knownSlugs.add(file.slice(0, -'.html'.length));
    }
  }
  for (const slug of knownSlugs) {
    if (active.has(slug)) continue;
    const p = cacheShellPath(slug);
    if (existsSync(p)) {
      try { rmSync(p, { force: true }); removedCache += 1; } catch {}
    }
  }

  // 2. Dist: dist/ is usually wiped by `vite build`, but if a prior partial
  // build left an orphan dir behind, sweep it so scrapers can't reach it.
  const distHouse = resolve(DIST, 'house');
  if (existsSync(distHouse)) {
    for (const entry of readdirSync(distHouse)) {
      const full = resolve(distHouse, entry);
      let isDir = false;
      try { isDir = statSync(full).isDirectory(); } catch { continue; }
      if (!isDir) continue;
      if (active.has(entry)) continue;
      try { rmSync(full, { recursive: true, force: true }); removedDist += 1; } catch {}
    }
  }

  return { removedCache, removedDist };
}

async function main() {
  if (!existsSync(TEMPLATE_PATH)) {
    console.warn(`prerender-houses: ${TEMPLATE_PATH} missing — skip (build not complete?)`);
    return;
  }
  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  const templateHash = createHash('sha1').update(template).digest('hex');
  const prev = loadManifest();
  // If the built index.html changed (new asset hashes, new sitewide meta,
  // updated script tags), every shell must be regenerated — the cached HTML
  // references stale bundle filenames.
  const templateChanged = FORCE || prev.templateHash !== templateHash;
  const prevEntries = templateChanged ? {} : prev.entries || {};
  const nextEntries = {};

  const listings = await fetchLiveHouses();
  if (!listings.length) {
    console.log('prerender-houses: no listings to prerender');
    return;
  }
  let files = 0;
  let rendered = 0;
  let reused = 0;
  const activeSlugs = [];
  for (const listing of listings) {
    // Canonical slug only — one shell per listing (matches sitemap + canonical).
    const slug = listing.short_code || listing.id;
    if (!slug) continue;
    const cacheKey = `${listing.updated_at || ''}`;
    // Primary cache lookup keyed by uuid (stable) — short_code can change but
    // uuid can't, so the cached HTML is bit-identical for both slugs.
    const primary = listing.id || listing.short_code;
    const prevRaw = prevEntries[primary];
    // Backward-compat: earlier manifest stored a bare string key per entry.
    const prevKey = typeof prevRaw === 'string' ? prevRaw : prevRaw?.key;
    const cacheHit =
      !templateChanged &&
      prevKey === cacheKey &&
      existsSync(cacheShellPath(primary));

    let html;
    if (cacheHit) {
      html = readFileSync(cacheShellPath(primary), 'utf8');
      reused += 1;
    } else {
      html = renderListingHtml(template, listing);
      saveShellToCache(primary, html);
      rendered += 1;
    }

    writeShell(slug, html);
    files += 1;
    activeSlugs.push(slug);
    nextEntries[primary] = { key: cacheKey, slugs: [slug] };
  }
  const { removedCache, removedDist } = cleanupStaleShells(activeSlugs, prevEntries, nextEntries);
  saveManifest({ version: 1, templateHash, entries: nextEntries });
  const mode = templateChanged ? 'full rebuild' : 'incremental';
  console.log(
    `prerender-houses: ${mode} — ${files} shells for ${listings.length} listings ` +
      `(rendered ${rendered}, reused ${reused}, pruned ${removedCache} cache + ${removedDist} dist)`,
  );
}

main().catch((err) => {
  // Never fail the build — social previews are an enhancement, not a blocker.
  console.warn('prerender-houses: unexpected error, continuing build', err);
});