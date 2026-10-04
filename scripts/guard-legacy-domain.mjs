#!/usr/bin/env node
/**
 * CI guard — fails the build if any shipping file still references the legacy
 * domains `welilereceipts.com` or the misspelled `welilereciept.com`.
 *
 * The canonical, public-facing domain is welileapp.com. No link, canonical
 * URL, og:url, sitemap entry, email link, or receipt URL may point at the old
 * domains — old links break SEO and land users on a parked page.
 *
 * The ONLY allowed occurrences are lines explicitly marked with the comment
 * `legacy-domain-guard-allow` (e.g. the index.html host-redirect guard, which
 * must name the legacy hosts in order to redirect them away).
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_DOMAIN,
  LEGACY_DOMAINS,
  buildLegacyDomainRegex,
} from './site-domains.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

// Only scan files that actually ship or produce public URLs.
const SCAN_TARGETS = [
  'src',
  'public',
  'supabase/functions',
  'index.html',
];

const SCANNABLE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.html', '.htm', '.xml', '.txt', '.json', '.css', '.webmanifest',
]);

// Legacy hostnames come from scripts/site-domains.mjs (env-configurable).
const LEGACY_RE = buildLegacyDomainRegex();
const ALLOW_MARKER = 'legacy-domain-guard-allow';

// Files whose entire purpose is to reference the legacy domain (redirect
// monitors, change-of-address tooling, and the legacy-domain sitemap that is
// submitted to Search Console so old URLs get a proper 301 to welileapp.com).
const ALLOW_FILES = new Set([
  'public/sitemap-welilereceipts.xml',
  'supabase/functions/change-of-address-monitor/index.ts',
  'supabase/functions/redirect-health-monitor/index.ts',
  'supabase/functions/verify-redirects/index.ts',
  'supabase/functions/seo-redirect-audit/index.ts',
  'supabase/functions/sitemap-resubmit/index.ts',
  'supabase/functions/seo-index-monitor/index.ts',
  'supabase/functions/seo-coverage-dashboard/index.ts',
  'src/components/executive/CTODashboard.tsx',
  'src/components/executive/ChangeOfAddressMonitorPanel.tsx',
  'src/components/executive/RedirectHealthAlertsPanel.tsx',
  'supabase/functions/_shared/transactional-email-templates/redirect-monitor-alert.tsx',
  // Captured build output (scripts/build-logger.mjs) — echoes whatever the
  // pipeline printed, including the legacy sitemap line. Not shipping code.
  'public/build-log.txt',
]);

function* walk(target) {
  const st = statSync(target);
  if (st.isFile()) { yield target; return; }
  for (const entry of readdirSync(target)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(target, entry);
    const s = statSync(full);
    if (s.isDirectory()) yield* walk(full);
    else if (SCANNABLE_EXT.has(extname(entry))) yield full;
  }
}

const violations = [];

for (const rel of SCAN_TARGETS) {
  const abs = join(REPO_ROOT, rel);
  if (!existsSync(abs)) continue;
  for (const file of walk(abs)) {
    const relPath = relative(REPO_ROOT, file).replace(/\\/g, '/');
    if (ALLOW_FILES.has(relPath)) continue;
    const src = readFileSync(file, 'utf8');
    src.split('\n').forEach((line, idx) => {
      if (!LEGACY_RE.test(line)) return;
      if (line.includes(ALLOW_MARKER)) return;
      violations.push({
        file: relative(REPO_ROOT, file),
        line: idx + 1,
        code: line.trim().slice(0, 200),
      });
    });
  }
}

if (violations.length > 0) {
  console.error('\n❌ Legacy-domain guard failed.\n');
  console.error(
    `Shipping code must reference ${CANONICAL_DOMAIN} — never ${LEGACY_DOMAINS.join(' / ')}.\n`,
  );
  console.error('Fix the URL, or if the reference is intentional (e.g. a redirect');
  console.error(`guard), append the comment "${ALLOW_MARKER}" to that line.\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`     ${v.code}`);
  }
  console.error(`\n${violations.length} violation(s). Build aborted.\n`);
  process.exit(1);
}

console.log(
  `✅ Legacy-domain guard passed — no ${LEGACY_DOMAINS.join(' / ')} references in shipping code.`,
);
