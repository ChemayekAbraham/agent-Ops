#!/usr/bin/env node
/**
 * CI guard — enforces correct canonical tags for welileapp.com.
 *
 * Two invariants:
 *   1. PRESENCE + CORRECTNESS: every public, indexable route (mirrors the
 *      static routes in scripts/generate-sitemap.ts) ships a react-helmet
 *      `<link rel="canonical">` that resolves to the exact welileapp.com URL
 *      for that route. Two routes are allow-listed (see ALLOWLIST) because
 *      their canonical is provided elsewhere or intentionally consolidates.
 *   2. GLOBAL CORRECTNESS: every `rel="canonical"` anywhere in src/ resolves
 *      to an absolute https://welileapp.com URL — never a relative path, the
 *      legacy domain, or any other host.
 *
 * Runs in the `build` script. The existing guard-legacy-domain.mjs is the
 * companion that blocks legacy-domain references; this one guarantees the
 * positive canonical is present and points at the right welileapp.com URL.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_ORIGIN } from './site-domains.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const BASE = CANONICAL_ORIGIN;

// Indexable public routes -> { file, expected canonical }. Mirrors the
// staticEntries list in scripts/generate-sitemap.ts.
const INDEXABLE = {
  '/welcome': { file: 'src/pages/Landing.tsx', expected: `${BASE}/welcome` },
  '/find-a-house': { file: 'src/pages/FindAHouse.tsx', expected: `${BASE}/find-a-house` },
  '/rent-money': { file: 'src/pages/RentMoney.tsx', expected: `${BASE}/rent-money` },
  '/become-supporter': { file: 'src/pages/BecomeSupporter.tsx', expected: `${BASE}/become-supporter` },
  '/funder-onboarding': { file: 'src/pages/Onboarding.tsx', expected: `${BASE}/funder-onboarding` },
  '/partner-onboarding': { file: 'src/pages/PartnerOnboarding.tsx', expected: `${BASE}/partner-onboarding` },
  '/opportunities': { file: 'src/pages/Opportunities.tsx', expected: `${BASE}/opportunities` },
  '/internship': { file: 'src/pages/Internship.tsx', expected: `${BASE}/internship` },
  '/careers': { file: 'src/pages/Careers.tsx', expected: `${BASE}/careers` },
  '/landlord-signup': { file: 'src/pages/LandlordSignup.tsx', expected: `${BASE}/landlord-signup` },
  '/rent-calculator': { file: 'src/pages/PublicRentCalculator.tsx', expected: `${BASE}/rent-calculator` },
  '/guides/pay-rent-in-installments-uganda': { file: 'src/pages/PayRentInstallmentsGuide.tsx', expected: `${BASE}/guides/pay-rent-in-installments-uganda` },
  '/ai': { file: 'src/components/ai-chat/WelileAIChatButton.tsx', expected: `${BASE}/ai` },
  '/terms': { file: 'src/pages/Terms.tsx', expected: `${BASE}/terms` },
  '/privacy': { file: 'src/pages/Privacy.tsx', expected: `${BASE}/privacy` },
  '/auth': { file: 'src/pages/Auth.tsx', expected: `${BASE}/auth` },
  '/unsubscribe': { file: 'src/pages/Unsubscribe.tsx', expected: `${BASE}/unsubscribe` },
  '/stop-sms': { file: 'src/pages/StopSms.tsx', expected: `${BASE}/stop-sms` },
  '/resume-sms': { file: 'src/pages/ResumeSms.tsx', expected: `${BASE}/resume-sms` },
};

// Routes whose per-route canonical is intentionally provided elsewhere.
const ALLOWLIST = {
  '/': 'Homepage canonical is set by the static <link rel="canonical"> in index.html.',
  '/onboarding': 'Onboarding variants intentionally consolidate to /funder-onboarding.',
};

// Tokens that resolve to the welileapp.com origin at runtime.
const ORIGIN_TOKENS = /^(getPublicOrigin\(\)|CANONICAL_ORIGIN)$/;

/** Extract the raw href expression from a `rel="canonical"` line. */
function extractHref(line) {
  const lit = line.match(/rel="canonical"\s+href="([^"]+)"/);
  if (lit) return { kind: 'literal', value: lit[1] };
  const tmpl = line.match(/rel="canonical"\s+href=\{`([^`]+)`\}/);
  if (tmpl) return { kind: 'expr', value: '`' + tmpl[1] + '`' };
  const expr = line.match(/rel="canonical"\s+href=\{([^}]+)\}/);
  if (expr) return { kind: 'expr', value: expr[1].trim() };
  return null;
}

/** Resolve a `const NAME = ...` string/template value within a file's source. */
function resolveConst(src, name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*(?:'([^']*)'|"([^"]*)"|\`([^\`]*)\`)`);
  const m = src.match(re);
  if (m) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (raw != null) return resolveTemplate(src, raw);
  }
  // `const NAME = getPublicOrigin()` / `const NAME = CANONICAL_ORIGIN`
  const originRe = new RegExp(`const\\s+${name}\\s*=\\s*(?:getPublicOrigin\\(\\)|CANONICAL_ORIGIN)`);
  if (originRe.test(src)) return BASE;
  return null;
}

/** Substitute ${...} placeholders in a template using in-file consts/tokens. */
function resolveTemplate(src, tpl) {
  if (tpl == null) return '';
  return tpl.replace(/\$\{([^}]+)\}/g, (_, inner) => {
    const token = inner.trim();
    if (ORIGIN_TOKENS.test(token)) return BASE;
    const c = resolveConst(src, token);
    return c ?? `\u0000UNRESOLVED:${token}\u0000`;
  });
}

/** Resolve a canonical href expression to a concrete URL, or null if dynamic. */
function resolveHref(src, href) {
  if (href.kind === 'literal') return href.value;
  let v = href.value;
  // Bare template literal captured without braces stripping.
  if (v.startsWith('`') && v.endsWith('`')) v = v.slice(1, -1);
  if (v.includes('${') || v.includes('`')) {
    const resolved = resolveTemplate(src, v.replace(/`/g, ''));
    return resolved.includes('\u0000UNRESOLVED') ? null : resolved;
  }
  if (ORIGIN_TOKENS.test(v)) return BASE;
  // Simple identifier -> const lookup.
  if (/^[A-Za-z_$][\w$]*$/.test(v)) return resolveConst(src, v);
  return null;
}

const violations = [];

// ---- Invariant 1: presence + correctness on indexable routes ----
for (const [route, { file, expected }] of Object.entries(INDEXABLE)) {
  const abs = join(REPO_ROOT, file);
  if (!existsSync(abs)) {
    violations.push(`Route ${route}: page file not found (${file}). Update guard mapping.`);
    continue;
  }
  const src = readFileSync(abs, 'utf8');
  const lines = src.split('\n').filter((l) => /rel="canonical"/.test(l));
  if (lines.length === 0) {
    violations.push(`Route ${route} (${file}): no <link rel="canonical"> found. Expected ${expected}`);
    continue;
  }
  const resolvedSet = lines.map((l) => {
    const h = extractHref(l);
    return h ? resolveHref(src, h) : null;
  });
  if (!resolvedSet.some((r) => r === expected)) {
    violations.push(
      `Route ${route} (${file}): canonical does not resolve to ${expected}. ` +
        `Found: ${resolvedSet.map((r) => r ?? 'dynamic/unresolved').join(', ')}`,
    );
  }
}

// ---- Invariant 2: global correctness of every canonical ----
const SCANNABLE = new Set(['.ts', '.tsx', '.js', '.jsx']);
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) yield* walk(full);
    else if (SCANNABLE.has(extname(entry))) yield full;
  }
}

for (const file of walk(join(REPO_ROOT, 'src'))) {
  const src = readFileSync(file, 'utf8');
  if (!src.includes('rel="canonical"')) continue;
  src.split('\n').forEach((line, idx) => {
    if (!/rel="canonical"/.test(line)) return;
    const h = extractHref(line);
    if (!h) return;
    const resolved = resolveHref(src, h);
    const rel = relative(REPO_ROOT, file);
    if (resolved === null) {
      // Dynamic canonical: require it be built from a welileapp.com origin.
      const usesWelile = src.includes(BASE) || /getPublicOrigin|CANONICAL_ORIGIN/.test(src);
      if (!usesWelile) {
        violations.push(`${rel}:${idx + 1} dynamic canonical not derived from ${BASE}: ${h.value}`);
      }
      return;
    }
    if (!resolved.startsWith(`${BASE}/`) && resolved !== BASE) {
      violations.push(`${rel}:${idx + 1} canonical must be an absolute ${BASE} URL, got: ${resolved}`);
    }
  });
}

if (violations.length > 0) {
  console.error('\n\u274c Canonical-tag guard failed.\n');
  console.error('Every indexable page must ship a react-helmet <link rel="canonical">');
  console.error(`that resolves to its exact ${BASE} URL, and no canonical anywhere may`);
  console.error('point at a relative path, the legacy domain, or another host.\n');
  for (const v of violations) console.error(`  \u2022 ${v}`);
  console.error(`\n${violations.length} violation(s). Build aborted.\n`);
  process.exit(1);
}

const n = Object.keys(INDEXABLE).length;
console.log(`\u2705 Canonical-tag guard passed — ${n} indexable routes carry correct welileapp.com canonicals.`);