#!/usr/bin/env node
/**
 * CI guard — fails the build if any file under src/ writes
 * `deposit_purpose: <expr>` into a `deposit_requests` payload without
 * routing the value through `safeDepositPurpose(...)` from
 * `@/lib/depositPurposeGuard`.
 *
 * Background: an empty string for the Postgres `deposit_purpose` enum
 * raises `invalid input value for enum deposit_purpose: ""` and leaves
 * the user staring at a dead Confirm button. Centralising the coercion
 * through `safeDepositPurpose()` makes that failure mode structurally
 * impossible — this script enforces that.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..', 'src');

// Files that legitimately reference deposit_purpose without writing it
// (read paths, type definitions, the guard itself).
const ALLOWLIST_FILES = new Set([
  'lib/depositPurposeGuard.ts',
  'integrations/supabase/types.ts',
]);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue;
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      yield full;
    }
  }
}

const violations = [];

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (ALLOWLIST_FILES.has(rel)) continue;
  const src = readFileSync(file, 'utf8');
  if (!src.includes('deposit_purpose')) continue;

  const lines = src.split('\n');
  // Track which line ranges are inside a `.from('deposit_requests')`
  // insert/update payload. We only police `deposit_purpose:` writes
  // INSIDE those ranges — local JS object literals (review-screen
  // result rows in TidVerification etc.) are read-paths, not writes,
  // and never reach Postgres.
  let depth = 0; // nested-brace depth inside an insert/update payload
  let inWritePayload = false;
  let pendingArm = false; // saw `.insert(` / `.update(` on a recent line, waiting for `{`
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Arm when we see `.from('deposit_requests') ... .insert(` or `.update(`.
    // We use a simple rolling window of the last 3 lines because Supabase
    // chains are typically multi-line.
    const window = lines.slice(Math.max(0, i - 3), i + 1).join(' ');
    if (
      /\.from\(\s*['"]deposit_requests['"]\s*\)/.test(window) &&
      /\.(insert|update|upsert)\s*\(/.test(line)
    ) {
      pendingArm = true;
    }

    // Count braces on this line to track payload depth.
    for (const ch of line) {
      if (ch === '{') {
        if (pendingArm && !inWritePayload) {
          inWritePayload = true;
          depth = 1;
          pendingArm = false;
        } else if (inWritePayload) {
          depth++;
        }
      } else if (ch === '}') {
        if (inWritePayload) {
          depth--;
          if (depth <= 0) {
            inWritePayload = false;
            depth = 0;
          }
        }
      }
    }

    if (!inWritePayload) continue;

    const m = line.match(/^\s*deposit_purpose\s*:\s*(.+?),?\s*$/);
    if (!m) continue;
    const value = m[1];
    // Allowed: explicit call to safeDepositPurpose(...)
    if (/safeDepositPurpose\s*\(/.test(value)) continue;
    // Allowed: identifier `safePurpose` (already coerced one line above
    // via safeDepositPurpose — DepositFlow.tsx pattern).
    if (/^safePurpose$/.test(value.trim())) continue;

    violations.push(`${rel}:${i + 1}  ${line.trim()}`);
  }
}

if (violations.length > 0) {
  console.error('\n❌ guard-deposit-purpose: forbidden direct deposit_purpose assignment(s):');
  for (const v of violations) console.error('  ' + v);
  console.error('\nRoute every value through safeDepositPurpose() from @/lib/depositPurposeGuard.');
  process.exit(1);
}

console.log('✓ guard-deposit-purpose: all deposit_purpose writes go through safeDepositPurpose()');