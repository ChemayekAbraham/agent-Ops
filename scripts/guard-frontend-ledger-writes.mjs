#!/usr/bin/env node
/**
 * CI guard — fails the build if any file under src/ contains a direct
 * mutation against the wallets or general_ledger tables.
 *
 * The frontend is intentionally locked out of all financial state changes.
 * Every money movement MUST go through a backend edge function which calls
 * the canonical create_ledger_transaction / apply_wallet_movement RPCs.
 *
 * Two zero-balance bootstrap inserts are the only allowed exceptions —
 * they create an empty wallet row (balance: 0) for a brand-new user and
 * cannot create drift.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..', 'src');

// Patterns that are forbidden anywhere in src/.
const FORBIDDEN = [
  { re: /\.from\(\s*['"]wallets['"]\s*\)\s*\.update\s*\(/, label: "wallets.update(" },
  { re: /\.from\(\s*['"]wallets['"]\s*\)\s*\.upsert\s*\(/, label: "wallets.upsert(" },
  { re: /\.from\(\s*['"]wallets['"]\s*\)\s*\.delete\s*\(/, label: "wallets.delete(" },
  { re: /\.from\(\s*['"]general_ledger['"]\s*\)\s*\.insert\s*\(/, label: "general_ledger.insert(" },
  { re: /\.from\(\s*['"]general_ledger['"]\s*\)\s*\.update\s*\(/, label: "general_ledger.update(" },
  { re: /\.from\(\s*['"]general_ledger['"]\s*\)\s*\.delete\s*\(/, label: "general_ledger.delete(" },
  // Merchant own-money claims decide what the company owes its agents, and
  // settlement pays against that record. The table is read-only from the
  // client by RLS (SELECT policies only) and guarded by
  // trg_enforce_merchant_oop_integrity in the database; this keeps a direct
  // write from being reintroduced here. Writes go through
  // review_merchant_out_of_pocket / settle_merchant_out_of_pocket.
  { re: /\.from\(\s*['"]merchant_out_of_pocket_advances['"](\s+as\s+any)?\s*\)\s*\.insert\s*\(/, label: "merchant_out_of_pocket_advances.insert(" },
  { re: /\.from\(\s*['"]merchant_out_of_pocket_advances['"](\s+as\s+any)?\s*\)\s*\.update\s*\(/, label: "merchant_out_of_pocket_advances.update(" },
  { re: /\.from\(\s*['"]merchant_out_of_pocket_advances['"](\s+as\s+any)?\s*\)\s*\.upsert\s*\(/, label: "merchant_out_of_pocket_advances.upsert(" },
  { re: /\.from\(\s*['"]merchant_out_of_pocket_advances['"](\s+as\s+any)?\s*\)\s*\.delete\s*\(/, label: "merchant_out_of_pocket_advances.delete(" },
  { re: /\.from\(\s*['"]merchant_oop_settlements['"](\s+as\s+any)?\s*\)\s*\.(insert|update|upsert|delete)\s*\(/, label: "merchant_oop_settlements write" },
  // Frontend MUST NOT do balance arithmetic — backend is the only authority.
  // Catches:  wallet.balance - amount,  w.withdrawable_balance += x,  etc.
  { re: /\bwallet\??\.(balance|withdrawable_balance|float_balance|advance_balance)\s*[-+]\s*\w/, label: "client-side wallet arithmetic" },
  // Common drift-prone helpers — must live in backend, not frontend.
  { re: /\brouteToFloat\s*\(/, label: "routeToFloat(" },
  { re: /\bvalidateBalance\s*\(/, label: "validateBalance(" },
];

// User-facing wallet surfaces MUST NOT read the wallets.* cache. They read
// the strict ledger-derived `get_user_wallet_view` RPC (or a hook that
// wraps it). Operator dashboards (CFO, FinOps, CEO, COO, CTO, HR, Manager,
// Executive) keep using the cache for reconciliation work.
const USER_FACING_PATH_PREFIXES = [
  'components/wallet/',
  'components/payments/',
  'components/agent/',
  'components/supporter/',
  'components/tenant/',
  'components/landlord/',
  'components/dashboards/',
  'pages/agent/',
  'pages/supporter/',
  'pages/tenant/',
  'pages/landlord/',
];
const OPERATOR_PATH_HINTS = [
  'cfo', 'financial-ops', 'manager', 'executive', 'admin',
  'ceo', 'coo', 'cto', 'hr', 'crm', 'cmo', 'reconcile',
];
const WALLET_CACHE_SELECT_RE = /\.from\(\s*['"]wallets['"]\s*\)\s*\.select\s*\(\s*['"][^'"]*\b(balance|withdrawable_balance|float_balance|advance_balance)\b/;
const WALLET_CACHE_ALLOW_FILES = new Set([
  // No exceptions. useWallet now reads strictly from get_user_wallet_view
  // (2026-05-01). Operator surfaces live under operator-allowlisted paths.
]);

function isUserFacing(rel) {
  const hasPrefix = USER_FACING_PATH_PREFIXES.some((p) => rel.startsWith(p));
  if (!hasPrefix) return false;
  const lower = rel.toLowerCase();
  if (OPERATOR_PATH_HINTS.some((h) => lower.includes(h))) return false;
  return true;
}

// Allowlist: file path → reason. Bootstrapping a wallet row with balance 0 is
// inert — it cannot create drift.
const ALLOWED_INSERTS = new Map([
  ['hooks/useWallet.ts', 'Bootstrap empty wallet row (balance: 0) on first load'],
]);

const WALLETS_INSERT_RE = /\.from\(\s*['"]wallets['"]\s*\)\s*\.insert\s*\(/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

const violations = [];

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');

  lines.forEach((line, idx) => {
    for (const { re, label } of FORBIDDEN) {
      if (re.test(line)) {
        violations.push({ file: rel, line: idx + 1, label, code: line.trim() });
      }
    }
    if (WALLETS_INSERT_RE.test(line) && !ALLOWED_INSERTS.has(rel)) {
      violations.push({
        file: rel, line: idx + 1, label: "wallets.insert(",
        code: line.trim(),
      });
    }
    if (
      WALLET_CACHE_SELECT_RE.test(line)
      && isUserFacing(rel)
      && !WALLET_CACHE_ALLOW_FILES.has(rel)
    ) {
      violations.push({
        file: rel, line: idx + 1,
        label: "user-facing wallets cache read (use get_user_wallet_view RPC)",
        code: line.trim(),
      });
    }
  });
}

if (violations.length > 0) {
  console.error('\n❌ Frontend ledger-write guard failed.\n');
  console.error('The frontend MUST NEVER mutate wallets or general_ledger directly.');
  console.error('Every money movement must go through a backend edge function.\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  → ${v.label}`);
    console.error(`     ${v.code}`);
  }
  console.error(`\n${violations.length} violation(s). Build aborted.\n`);
  process.exit(1);
}

console.log('✅ Frontend ledger-write guard passed — no direct wallet/ledger mutations found.');