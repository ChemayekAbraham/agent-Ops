import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Regression tests for the wallet-side effects of Food M1 meal payments
 * (ledger rows with category 'wallet_transfer' and source_table 'food_orders'):
 *   4a  a canteen payment is never classified as a "Welile item" transfer;
 *   3   it never grows the recipient's Shopping Advance limit;
 *   4b  custodial cash uses the NET of both wallet_transfer legs.
 */

// ── a chainable PostgREST stand-in for fetchTxFeedPage ──
let feedRows: Record<string, unknown>[] = [];
const calls: Array<[string, unknown[]]> = [];
function builder() {
  const b: Record<string, unknown> = {};
  for (const op of ['select', 'eq', 'in', 'or', 'ilike', 'lt', 'gte', 'order', 'not', 'neq', 'is']) {
    b[op] = (...args: unknown[]) => { calls.push([op, args]); return b; };
  }
  b.limit = (...args: unknown[]) => { calls.push(['limit', args]); return Promise.resolve({ data: feedRows, error: null }); };
  return b;
}
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => builder(),
    rpc: () => Promise.resolve({ data: [], error: null }),
  },
}));

import { welileItemOf, fetchTxFeedPage, FOOD_ORDER_SOURCE_TABLE } from '@/lib/transactionsFeed';
import { netWalletTransferOutflow } from '@/lib/custodialTransfers';

const row = (over: Record<string, unknown>) => ({
  id: String(Math.random()), transaction_date: '2026-10-13T09:00:00Z', amount: 4000,
  direction: 'cash_out', category: 'wallet_transfer', description: null,
  reference_id: 'WT-1', linked_party: null, source_table: 'wallet_transactions', source_id: null,
  classification: null, ...over,
});

beforeEach(() => { feedRows = []; calls.length = 0; });

describe('4a: canteen payments are not Welile item transfers', () => {
  it('a Send Money item transfer is still recognised', () => {
    expect(welileItemOf(row({ description: 'Welile Chapati for lunch' }))).toBe('Welile Chapati');
  });
  it('a food payment naming a Welile item is not', () => {
    expect(welileItemOf(row({ description: 'Canteen order FO-1: Welile Chapati x2', source_table: FOOD_ORDER_SOURCE_TABLE })))
      .toBeNull();
  });
  it('rows with no source_table keep the old behaviour', () => {
    expect(welileItemOf(row({ description: 'Welile Eggs', source_table: null }))).toBe('Welile Eggs');
  });
  it('the item filter drops a canteen payment that the server-side text match returned', async () => {
    feedRows = [
      row({ id: 'send', description: 'Welile Bread from Ann' }),
      row({ id: 'food', description: 'Canteen order FO-2: Welile Bread', source_table: 'food_orders', reference_id: 'FOOD-2' }),
    ];
    const page = await fetchTxFeedPage('u1', { date: 'all', service: 'all', method: 'all', item: 'Welile Bread' } as never, null);
    expect(page.rows.map((r) => r.id)).toEqual(['send']);
  });
  it('without an item filter the canteen payment is still listed', async () => {
    feedRows = [row({ id: 'food', description: 'Canteen order FO-3', source_table: 'food_orders', reference_id: 'FOOD-3' })];
    const page = await fetchTxFeedPage('u1', { date: 'all', service: 'all', method: 'all' } as never, null);
    expect(page.rows.map((r) => r.id)).toEqual(['food']);
  });
});

describe('3: canteen payments never grow the Shopping Advance limit', () => {
  const src = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8');
  it('wallet-transfer excludes food_orders rows before summing, keeping rows with no source', () => {
    const s = src('supabase/functions/wallet-transfer/index.ts');
    const block = s.slice(s.indexOf("Shopping Advance access limit"), s.indexOf('const fmtUgx'));
    expect(block).toMatch(/\.select\('amount, source_table'\)/);
    expect(block).toMatch(/\.filter\(\(r: \{ source_table\?: string \| null \}\) => r\.source_table !== 'food_orders'\)\s*\.reduce/);
    expect(block).not.toMatch(/\.neq\('source_table'/);   // would also drop NULL-source rows
  });
  it('the Shopping Advance history screen applies the same exclusion', () => {
    const s = src('src/components/wallet/ShoppingAdvanceHistory.tsx');
    expect(s).toMatch(/linked_party, source_table'\)/);
    expect(s).toMatch(/\.filter\(\(r: \{ source_table\?: string \| null \}\) => r\.source_table !== 'food_orders'\)\s*\.map/);
  });
});

describe('4b: custodial transfers use the net of both legs', () => {
  it('a balanced person-to-person transfer leaves custodial cash unchanged', () => {
    expect(netWalletTransferOutflow(5000, 5000)).toBe(0);
  });
  it('an outflow without its inflow in scope is still an outflow', () => {
    expect(netWalletTransferOutflow(5000, 0)).toBe(5000);
  });
  it('a platform-funded transfer into wallets is a net inflow', () => {
    expect(netWalletTransferOutflow(0, 3000)).toBe(-3000);
  });
  it('the statements hook feeds both legs into the custodial line', () => {
    const s = readFileSync(resolve(__dirname, '..', 'hooks', 'useFinancialStatements.ts'), 'utf8');
    expect(s).toMatch(/netWalletTransferOutflow\(\s*sumBy\(walletOut, \['wallet_transfer'\]\), sumBy\(walletIn, \['wallet_transfer'\]\)\)/);
    expect(s).not.toMatch(/const userTransfers = sumBy\(walletOut, \['wallet_transfer'\]\);/);
  });
});
