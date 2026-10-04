#!/usr/bin/env node
/**
 * guard-persona-routes.mjs
 *
 * Static guard that fails the build if either:
 *   1. Any source file references a bare persona root path
 *      (e.g. `'/tenant'`, `"/agent"`, `` `/funder` ``) — every persona
 *      dashboard MUST live under `/dashboard/{role}`.
 *   2. `PERSONA_SLUGS` in `src/lib/roleRoutes.ts` contains an entry that
 *      does not start with `/dashboard/`.
 *
 * Run with:  node scripts/guard-persona-routes.mjs
 *
 * Sub-routes like `/agent/partners` or `/tenant/request-rent` are explicitly
 * allowed — only the bare persona root is forbidden, because that is the
 * old persona-dashboard URL we replaced.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const SCAN_DIRS = ['src', 'supabase/functions'];
const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.turbo', '.cache']);
const IGNORE_FILES = new Set([
  'src/integrations/supabase/types.ts', // generated
  'scripts/guard-persona-routes.mjs',   // self
]);

const PERSONA_ROOTS = ['tenant', 'agent', 'landlord', 'funder', 'manager', 'supporter'];

// Match a quoted string that is exactly "/<persona>" — bare root only.
// e.g. flags  '/agent'  "/funder"  `/tenant`
//      ignores  '/agent/partners'  '/dashboard/agent'  'supporter'
const BARE_PERSONA_REGEX = new RegExp(
  `(['"\`])\\/(?:${PERSONA_ROOTS.join('|')})\\1`,
  'g',
);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (SCAN_EXTS.has(extname(entry))) out.push(full);
  }
  return out;
}

const offenders = [];
for (const sub of SCAN_DIRS) {
  const abs = join(ROOT, sub);
  let files;
  try { files = walk(abs); } catch { continue; }
  for (const file of files) {
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    if (IGNORE_FILES.has(rel)) continue;
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      // Skip same-line ignore directive.
      if (line.includes('persona-route-guard:ignore')) return;
      const matches = line.match(BARE_PERSONA_REGEX);
      if (matches) {
        for (const m of matches) {
          offenders.push({ file: rel, line: i + 1, match: m, snippet: line.trim() });
        }
      }
    });
  }
}

// Verify PERSONA_SLUGS itself is well-formed.
const slugFile = join(ROOT, 'src/lib/roleRoutes.ts');
const slugSrc = readFileSync(slugFile, 'utf8');
const slugBlockMatch = slugSrc.match(/PERSONA_SLUGS\s*=\s*\[([\s\S]*?)\]/);
const slugProblems = [];
if (!slugBlockMatch) {
  slugProblems.push('Could not locate PERSONA_SLUGS array in src/lib/roleRoutes.ts');
} else {
  const slugs = [...slugBlockMatch[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  if (slugs.length === 0) slugProblems.push('PERSONA_SLUGS is empty');
  for (const s of slugs) {
    if (!s.startsWith('/dashboard/')) {
      slugProblems.push(`PERSONA_SLUGS entry "${s}" must start with "/dashboard/"`);
    }
  }
}

const hasFailure = offenders.length > 0 || slugProblems.length > 0;

if (hasFailure) {
  console.error('\n❌ Persona route guard FAILED\n');
  if (offenders.length) {
    console.error(`Found ${offenders.length} bare /{role} literal(s). Use /dashboard/{role} instead:\n`);
    for (const o of offenders) {
      console.error(`  ${o.file}:${o.line}  ${o.match}`);
      console.error(`      → ${o.snippet}`);
    }
    console.error('');
  }
  if (slugProblems.length) {
    console.error('PERSONA_SLUGS problems:');
    for (const p of slugProblems) console.error(`  - ${p}`);
    console.error('');
  }
  console.error('To intentionally allow a single line, append a comment:  // persona-route-guard:ignore');
  process.exit(1);
}

console.log('✅ Persona route guard passed — all persona links use /dashboard/{role}.');
