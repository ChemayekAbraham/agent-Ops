#!/usr/bin/env node
/**
 * CI guard — fails the build if a committed MCP edge-function bundle has been
 * replaced by the broken stub that @lovable.dev/mcp-js emits on Windows.
 *
 * Background: the bundler does not recognise its own entry when the path has
 * backslashes, so it marks the entry external and writes a three-line file
 *   import mcp from "npm:C:\...\src\lib\mcp\index.ts";
 * over supabase/functions/mcp/index.ts and mcp-public/index.ts. That package
 * does not exist, so deploying either file takes the MCP endpoints down. The
 * bundler is skipped on Windows (see scripts/run-guards.mjs context and
 * WELILE_MCP_BUNDLE=1), but nothing stopped a stub from being committed.
 *
 * Two cheap, unambiguous signatures of the stub:
 *   1. the file is tiny — a real bundle is tens of KB, the stub is ~150 bytes;
 *   2. it contains an `npm:<drive>:` import, which is never valid.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..');

const BUNDLES = [
  'supabase/functions/mcp/index.ts',
  'supabase/functions/mcp-public/index.ts',
];

const MIN_BYTES = 10 * 1024;
// `npm:C:\...` — an absolute Windows path smuggled into an npm specifier.
const STUB_IMPORT = /npm:[A-Za-z]:/;

const violations = [];

for (const rel of BUNDLES) {
  const full = resolve(ROOT, rel);

  let size;
  try {
    size = statSync(full).size;
  } catch (err) {
    violations.push(`${rel}  missing or unreadable (${err.code ?? err.message})`);
    continue;
  }

  if (size < MIN_BYTES) {
    violations.push(`${rel}  ${size} bytes — below the ${MIN_BYTES}-byte floor for a real bundle`);
  }

  const src = readFileSync(full, 'utf8');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (STUB_IMPORT.test(lines[i])) {
      violations.push(`${rel}:${i + 1}  ${lines[i].trim()}`);
    }
  }
}

if (violations.length > 0) {
  console.error('\n❌ guard-mcp-bundles: MCP edge-function bundle looks like the Windows stub:');
  for (const v of violations) console.error('  ' + v);
  console.error('\nThe @lovable.dev/mcp-js bundler overwrote a bundle with an import of a');
  console.error('package that does not exist. Do not commit or deploy these files —');
  console.error('restore them from origin/lovable:');
  console.error('  git checkout origin/lovable -- supabase/functions/mcp/index.ts supabase/functions/mcp-public/index.ts');
  process.exit(1);
}

console.log(`✓ guard-mcp-bundles: ${BUNDLES.length} MCP bundles intact (no stub imports, all ≥ ${MIN_BYTES} bytes)`);
