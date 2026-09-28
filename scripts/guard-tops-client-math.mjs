#!/usr/bin/env node
/**
 * CI guard — keeps money/rate arithmetic out of the Tenant Ops Workspace
 * frontend.
 *
 * SYSTEM_CONTEXT.md's standing rule: "No money arithmetic in the browser.
 * Every figure comes from a tops_ RPC and carries a basis string and an
 * as-at time." The workspace's RPCs already compute every percentage,
 * coverage ratio and arrears total in SQL (see e.g. tops_collection_
 * scoreboard's coverage_pct, tops_portfolio_quality's repayment_rate_*,
 * tops_open_instalments_asof's outstanding_ugx) — the frontend's only job is
 * to format and display those fields, never to re-derive them from raw
 * figures.
 *
 * WHAT THIS CATCHES
 *   A. Dividing one money/rate figure by another inline — the frontend
 *      equivalent of computing a coverage percentage or a ratio itself
 *      (`paid_ugx / expected_ugx`, `onSchedule / expected * 100`).
 *   B. Assigning to a variable/prop named like a coverage or arrears figure
 *      using any inline arithmetic (`const arrearsUgx = expected - paid;`),
 *      even without division.
 *
 * WHAT IT DELIBERATELY DOES NOT CATCH (by design, not a gap)
 *   - Formatting an ALREADY-COMPUTED ratio field for display, e.g.
 *     `Math.round(row.coverage_pct * 1000) / 10` — that divides by a bare
 *     numeric literal (10/100/1000), never by a second figure, so the left
 *     operand touching `/` never contains one of the keywords below.
 *   - Client-side UI pagination math (`rows.length / PAGE_SIZE`) — neither
 *     operand is a money/rate keyword.
 *   - A TypeScript union type alias like `'1-7' | '8-14'` (bucket-key
 *     types) — `type`/`export type` declaration lines are skipped outright
 *     so a hyphen inside a string-literal union can never trip rule B.
 *
 * Usage: node scripts/guard-tops-client-math.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const ROOTS = [
  join(REPO_ROOT, 'src', 'components', 'tenant-ops-workspace'),
  join(REPO_ROOT, 'src', 'hooks', 'tenantOpsWorkspace'),
];

// Money/rate keywords. A word touching the operator must contain one of
// these (case-insensitive) for either rule to fire. Lookaround requires a
// non-letter (underscore, digit, string start/end) on both sides of the
// matched keyword — snake_case identifiers like `expected_ugx` match, but
// the keyword can never be silently matched as a substring of an unrelated
// English word in camelCase or prose (e.g. "ratio" inside "integrations" or
// "operations", "total" inside "totalRows").
const KEYWORDS = [
  'ugx', 'amount', 'expected', 'paid', 'collected', 'coverage', 'arrears',
  'outstanding', 'balance', 'repaid', 'repayment', 'owed', 'due', 'pct',
  'percent', 'ratio', 'total', 'obligation', 'adequacy', 'float',
];
const KEYWORD_RE = KEYWORDS.map((k) => `(?<![a-zA-Z])${k}(?![a-zA-Z])`).join('|');

// Rule A — division between a money/rate figure and any non-literal figure.
// The word immediately left of `/` must contain a keyword; a bare numeric
// literal (10, 100, 1000 — the only divisors the existing display-formatting
// helpers use) never contains one, so `x * 1000) / 10` cannot match.
const RULE_A = new RegExp(`\\w*(?:${KEYWORD_RE})\\w*\\s*/\\s*[a-zA-Z_$]`, 'i');

// Rule B — assigning to a coverage/arrears-named binding via inline
// arithmetic. Matched in two steps (see checkRuleB): first find the
// assignment (`[:=]`, not `==`/`===`), capturing the right-hand side up to a
// JSX/statement boundary; then check THAT text for an actual
// operand-operator-operand sequence, not just an operator character
// appearing anywhere later on the line (a bare `/` from a JSX closing tag
// like `</TableCell>` would otherwise always match).
const RULE_B_ASSIGN = /\w*(?:coverage|arrears)\w*\s*[:=](?!=)\s*([^;,\n<}]*)/i;
const OPERATOR_BETWEEN_OPERANDS = /[\w.\])]\s*[+\-*/]\s*[\w.[(]/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    // Test files build fixture data with ordinary arithmetic (e.g.
    // `running_arrears_ugx: seq * 5_000` for a fake row) — that is test
    // setup, not the app deriving a figure it should have read from an RPC.
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) yield full;
  }
}

const violations = [];

for (const root of ROOTS) {
  let files;
  try {
    files = [...walk(root)];
  } catch {
    continue; // directory doesn't exist yet — nothing to scan
  }

  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');

    lines.forEach((rawLine, idx) => {
      const line = rawLine.trim();
      if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) return;
      // A union-of-string-literals type alias can contain a bare hyphen
      // ('1-7' | '8-14') that would otherwise trip rule B's operator check.
      if (/^export\s+type\b/.test(line) || /^type\b/.test(line)) return;

      if (RULE_A.test(rawLine)) {
        violations.push({
          file: rel, line: idx + 1, code: line,
          label: 'divides one figure by another inline (compute this in the RPC, not the browser)',
        });
      }
      const assignMatch = RULE_B_ASSIGN.exec(rawLine);
      if (assignMatch && OPERATOR_BETWEEN_OPERANDS.test(assignMatch[1])) {
        violations.push({
          file: rel, line: idx + 1, code: line,
          label: 'computes a coverage/arrears value inline (read it from a tops_ RPC field instead)',
        });
      }
    });
  }
}

if (violations.length > 0) {
  console.error('\n❌ Tenant Ops Workspace client-math guard failed.\n');
  console.error('Every coverage/arrears/percentage figure must come from a tops_ RPC field.');
  console.error('The browser may format a figure it is given, but must never derive one.\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  → ${v.label}`);
    console.error(`     ${v.code}`);
  }
  console.error(`\n${violations.length} violation(s). Build aborted.\n`);
  process.exit(1);
}

console.log('✅ Tenant Ops Workspace client-math guard passed — no inline coverage/arrears/percentage arithmetic found.');
