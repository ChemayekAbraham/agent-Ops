import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

/**
 * Issue A — no browser session posts to the ledger directly.
 * The database side (EXECUTE revoked on every create_ledger_transaction*
 * overload; post_portfolio_roi_ledger checks the caller, bounds the amount,
 * picks the recipient and builds the legs) is proven in
 * supabase/tests/ledger_boundary/local (A-01…A-31). This pins the client side.
 */
const SRC = resolve(__dirname, '..');
const page = readFileSync(join(SRC, 'components', 'coo', 'COOPartnersPage.tsx'), 'utf8');

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) yield* walk(f);
    else if (/\.(ts|tsx)$/.test(e)) yield f;
  }
}

describe('COO / Partners Ops Returns postings go through the server boundary', () => {
  it('the page no longer calls create_ledger_transaction', () => {
    expect(page).not.toMatch(/rpc\(\s*['"`]create_ledger_transaction/);
  });

  it('it calls post_portfolio_roi_ledger for exactly the three postings', () => {
    const calls = page.match(/rpc\(\s*'post_portfolio_roi_ledger'/g) ?? [];
    expect(calls).toHaveLength(3);
    expect(page).toMatch(/p_operation: 'compound',\s*p_portfolio_id: portfolio\.id,\s*p_amount: roiAmount,/);
    expect(page).toMatch(/p_operation: 'compound',\s*p_portfolio_id: p\.portfolioId,\s*p_amount: roiAmount,/);
    expect(page).toMatch(/p_operation: isKeepReturns \? 'split_keep_returns' : 'split_reinvest',\s*p_portfolio_id: p\.portfolioId,\s*p_amount: reinvestAmount,/);
  });

  it('the page sends no recipient, wallet, scope, category or entries to the boundary', () => {
    const blocks = page.split("rpc('post_portfolio_roi_ledger'").slice(1).map((b) => b.slice(0, b.indexOf('} as never)')));
    expect(blocks).toHaveLength(3);
    for (const b of blocks) {
      expect(b).not.toMatch(/\b(entries|user_id|ledger_scope|category|wallet_bucket|recipient_type|skip_balance_check)\s*:/);
    }
  });

  it('no application file (tests excepted) calls create_ledger_transaction directly', () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f);
      if (/(^|[\\/])(__tests__|test)[\\/]|\.(test|spec)\.tsx?$/.test(rel)) continue;
      if (/\.rpc\(\s*['"`]create_ledger_transaction/.test(readFileSync(f, 'utf8'))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  }, 120_000);   // walks every file under src/
});
