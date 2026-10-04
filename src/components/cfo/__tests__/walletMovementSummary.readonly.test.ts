import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─────────────────────────────────────────────────────────────
// Regression guard: the bucket flow panel must remain read-only.
// It must never mutate wallet balances, call RPCs, or write to
// ledger / wallet tables. This test scans the source of the
// WalletMovementSummary block and fails if any forbidden Supabase
// method (or direct `supabase.` reference bypassing the guarded
// `readOnlyLedger()` helper) is introduced.
// ─────────────────────────────────────────────────────────────
const FILE = resolve(__dirname, '../ComprehensiveCashMovement.tsx');
const SOURCE = readFileSync(FILE, 'utf8');

function extractWalletMovementSummaryBlock(src: string): string {
  const start = src.indexOf('function WalletMovementSummary(');
  if (start === -1) throw new Error('WalletMovementSummary not found');
  // Block ends at the next top-level `function ` declaration or EOF.
  const rest = src.slice(start + 1);
  const nextFn = rest.indexOf('\nfunction ');
  const end = nextFn === -1 ? src.length : start + 1 + nextFn;
  return src.slice(start, end);
}

describe('WalletMovementSummary (bucket flow panel) — read-only safety guard', () => {
  const block = extractWalletMovementSummaryBlock(SOURCE);

  // Supabase chain methods are unique enough that string scans suffice for
  // insert/update/upsert/rpc. `.delete(` is special — Set/Map also expose it
  // — so we only flag it when used at the end of a chain (`).delete(`).
  const forbiddenStrings = ['.insert(', '.update(', '.upsert(', '.rpc('];
  for (const token of forbiddenStrings) {
    it(`must not contain forbidden Supabase call ${token}`, () => {
      expect(block.includes(token), `Found ${token} in WalletMovementSummary`).toBe(false);
    });
  }
  it('must not contain a chained Supabase .delete( call', () => {
    expect(/\)\s*\.\s*delete\s*\(/.test(block)).toBe(false);
  });

  it('must not write to wallets, general_ledger, or wallet_ledger tables directly', () => {
    const writeTargets = [
      /\.from\(['"]wallets['"]\)\s*\.(insert|update|delete|upsert)/,
      /\.from\(['"]general_ledger['"]\)\s*\.(insert|update|delete|upsert)/,
      /\.from\(['"]wallet_ledger['"]\)\s*\.(insert|update|delete|upsert)/,
    ];
    for (const re of writeTargets) {
      expect(re.test(block), `Forbidden write matched ${re}`).toBe(false);
    }
  });

  it('uses the guarded readOnlyLedger() helper, not bare supabase.from(...) for queries', () => {
    // The only Supabase touchpoint inside the panel should be readOnlyLedger().
    // A bare `supabase.from(` inside this block bypasses the Proxy guard.
    expect(/\bsupabase\s*\.\s*from\s*\(/.test(block)).toBe(false);
    expect(block.includes('readOnlyLedger()')).toBe(true);
  });

  it('readOnlyLedger Proxy guard exists in the file', () => {
    expect(SOURCE.includes('WALLET_PANEL_FORBIDDEN_METHODS')).toBe(true);
    expect(SOURCE.includes('bucket flow panel must remain read-only')).toBe(true);
  });
});