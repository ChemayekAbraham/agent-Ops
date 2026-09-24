/**
 * Integration tests: seeded wallet + ledger records run through the REAL
 * customer-history filters (query-level and row-level) and the real statement
 * loader. The expected "wallet card" figure follows the card's rule in
 * FullScreenWalletSheet: withdrawable + float.
 *
 * Uses an in-memory seeded database only — never touches real accounts.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

type Row = Record<string, any>;
const DB: { general_ledger: Row[]; wallets: Row[] } = { general_ledger: [], wallets: [] };

function query(table: 'general_ledger' | 'wallets') {
  const f: ((r: Row) => boolean)[] = [];
  const run = () => DB[table].filter((r) => f.every((p) => p(r)));
  const q: any = {
    select: () => q,
    eq: (k: string, v: any) => (f.push((r) => r[k] === v), q),
    neq: (k: string, v: any) => (f.push((r) => r[k] !== v), q), // SQL: NULL <> x is not true
    in: (k: string, vs: any[]) => (f.push((r) => vs.includes(r[k])), q),
    not: (k: string, op: string, list: string) => {
      const vs = list.replace(/^\(|\)$/g, '').split(',');
      if (op !== 'in') throw new Error(`unsupported not.${op}`);
      f.push((r) => r[k] != null && !vs.includes(r[k]));
      return q;
    },
    gte: (k: string, v: string) => (f.push((r) => r[k] >= v), q),
    lte: (k: string, v: string) => (f.push((r) => r[k] <= v), q),
    gt: (k: string, v: string) => (f.push((r) => r[k] > v), q),
    lt: (k: string, v: string) => (f.push((r) => r[k] < v), q),
    order: () => q,
    range: (a: number, b: number) => Promise.resolve({
      data: run().sort((x, y) => x.transaction_date.localeCompare(y.transaction_date) || x.id.localeCompare(y.id)).slice(a, b + 1),
      error: null,
    }),
    maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
  };
  return q;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: any) => query(t) } }));
vi.mock('@/assets/welile-logo.png', () => ({ default: '' }));

import { loadPeriodStatement, reconciliationLines } from './walletPeriodStatement';
import { isCustomerWalletLedgerEntryVisible } from './customerWalletHistory';

let seq = 0;
function leg(user_id: string, date: string, amount: number, direction: 'cash_in' | 'cash_out', extra: Row = {}) {
  DB.general_ledger.push({
    id: `GL${String(++seq).padStart(5, '0')}`, user_id, transaction_date: date, amount, direction,
    category: 'wallet_deposit', ledger_scope: 'wallet', classification: 'production',
    description: null, reference_id: null, linked_party: null, source_table: null, source_id: null, ...extra,
  });
}
const signed = (r: Row) => (r.direction === 'cash_in' ? 1 : -1) * r.amount;
const walletCard = (u: string, isAgent = true) => {
  const w = DB.wallets.find((x) => x.user_id === u)!;
  return w.withdrawable_balance + (isAgent ? w.float_balance : 0);
};

const A = 'seed-user-a'; // ordinary activity + hidden internal corrections
const B = 'seed-user-b'; // clean wallet: listed transactions add up exactly
const C = 'seed-user-c'; // no activity at all
const D = 'seed-user-d'; // non-agent with money sitting in float

beforeAll(() => {
  // ---- User A: June → September 2026 ----
  leg(A, '2026-06-03T07:00:00Z', 2_000_000, 'cash_in', { category: 'salary_payout', source_table: 'hr_pay_disbursements' });
  leg(A, '2026-06-18T09:00:00Z', 350_000, 'cash_out', { category: 'wallet_withdrawal', source_table: 'withdrawal_requests' });
  leg(A, '2026-06-30T20:59:59.999Z', 40_000, 'cash_out', { category: 'wallet_transfer' });  // 23:59:59 Kampala 30 Jun
  leg(A, '2026-06-30T21:00:00Z', 60_000, 'cash_in', { category: 'wallet_transfer' });      // 00:00 Kampala 1 Jul
  leg(A, '2026-07-05T10:00:00Z', 1_200_000, 'cash_in', { category: 'roi_wallet_credit' });
  leg(A, '2026-07-20T10:00:00Z', 900_000, 'cash_out', { category: 'partner_funding', source_table: 'investor_portfolios' });
  leg(A, '2026-08-01T05:00:00Z', 500_000, 'cash_in', { category: 'wallet_deposit', source_table: 'deposit_requests' });
  leg(A, '2026-08-02T05:00:00Z', 75_000, 'cash_out', { category: 'wallet_transfer' });
  leg(A, '2026-08-03T05:00:00Z', 20_000, 'cash_in', { category: 'agent_commission' });
  leg(A, '2026-08-25T05:00:00Z', 1_100_000, 'cash_out', { category: 'wallet_withdrawal' });
  leg(A, '2026-09-10T05:00:00Z', 300_000, 'cash_in', { category: 'salary_payout' });
  // Hidden from customer history (each by a different rule):
  leg(A, '2026-07-10T00:00:00Z', 111_000, 'cash_in', { classification: 'admin_correction' });
  leg(A, '2026-08-02T06:00:00Z', 50_000, 'cash_out', { category: 'system_balance_correction' });
  leg(A, '2026-08-05T06:00:00Z', 7_000, 'cash_in', { source_table: 'wallet_reconciliation' });
  leg(A, '2026-08-06T06:00:00Z', 9_000, 'cash_out', { reference_id: 'RECON-0001' });
  leg(A, '2026-08-07T06:00:00Z', 4_000, 'cash_in', { description: 'Internal accounting adjustment' });
  // Not the user's wallet: platform leg and another user's leg.
  leg(A, '2026-08-01T05:00:01Z', 500_000, 'cash_out', { ledger_scope: 'platform' });
  leg(B, '2026-08-01T05:00:02Z', 9_999_999, 'cash_in');

  // User A's card: wallet includes an extra UGX 63,000 of internal corrections.
  const listedA = DB.general_ledger.filter((r) => r.user_id === A && r.ledger_scope === 'wallet' && isCustomerWalletLedgerEntryVisible(r))
    .reduce((s, r) => s + signed(r), 0);
  DB.wallets.push({ user_id: A, withdrawable_balance: listedA + 63_000 - 25_000, float_balance: 25_000, balance: 1 /* drifted cache, ignored */ });

  // ---- User B: clean ----
  leg(B, '2026-08-10T05:00:00Z', 400_000, 'cash_in');
  leg(B, '2026-08-11T05:00:00Z', 150_000, 'cash_out');
  DB.wallets.push({ user_id: B, withdrawable_balance: 10_249_999, float_balance: 0, balance: 10_249_999 });

  // ---- User C: empty ----
  DB.wallets.push({ user_id: C, withdrawable_balance: 0, float_balance: 0, balance: 0 });

  // ---- User D: non-agent with float the card never shows ----
  leg(D, '2026-08-05T05:00:00Z', 200_000, 'cash_in');
  leg(D, '2026-08-06T05:00:00Z', 50_000, 'cash_out');
  DB.wallets.push({ user_id: D, withdrawable_balance: 150_000, float_balance: 80_000, balance: 230_000 });
});

function tieOut(st: Awaited<ReturnType<typeof loadPeriodStatement>>) {
  expect(st.opening + st.totalIn - st.totalOut).toBe(st.closing);
  expect(st.rows.at(-1)?.balance ?? st.opening).toBe(st.closing);
  st.rows.forEach((r) => expect(isCustomerWalletLedgerEntryVisible(r)).toBe(true));
}

describe('wallet statement vs wallet card (seeded records)', () => {
  it('short range: 1–3 Aug', async () => {
    const st = await loadPeriodStatement(A, '2026-08-01', '2026-08-03', { isAgent: true });
    tieOut(st);
    expect(st.rows).toHaveLength(3);
    expect(st.totalIn).toBe(520_000);
    expect(st.totalOut).toBe(75_000);
  });

  it('full month: July respects Kampala midnight and hides corrections', async () => {
    const st = await loadPeriodStatement(A, '2026-07-01', '2026-07-31', { isAgent: true });
    tieOut(st);
    expect(st.rows).toHaveLength(3); // 1 Jul 00:00 transfer, Returns, portfolio; not the admin correction
    expect(st.totalIn).toBe(1_260_000);
    expect(st.totalOut).toBe(900_000);
  });

  it('multi-month range ending today closes exactly on the wallet card', async () => {
    const st = await loadPeriodStatement(A, '2026-06-01', '2026-09-30', { isAgent: true });
    tieOut(st);
    expect(st.rows).toHaveLength(11);
    expect(st.closing).toBe(walletCard(A));
    expect(st.opening).toBe(63_000); // only the hidden corrections remain unexplained by listed rows
    expect(st.reconciliation!.internalAdjustments).toBe(63_000);
    expect(reconciliationLines(st)[7][2]).toMatch(/Internal balance corrections/);
  });

  it('consecutive months chain and sum to the whole range', async () => {
    const months = [['2026-06-01', '2026-06-30'], ['2026-07-01', '2026-07-31'], ['2026-08-01', '2026-08-31'], ['2026-09-01', '2026-09-30']];
    const sts = await Promise.all(months.map(([f, t]) => loadPeriodStatement(A, f, t, { isAgent: true })));
    sts.forEach(tieOut);
    for (let i = 1; i < sts.length; i++) expect(sts[i].opening).toBe(sts[i - 1].closing);
    expect(sts.at(-1)!.closing).toBe(walletCard(A));
    expect(sts.reduce((s, x) => s + x.rows.length, 0)).toBe(11);
  });

  it('ignores the drifted cached balance and uses the card rule', async () => {
    const st = await loadPeriodStatement(A, '2026-09-01', '2026-09-30', { isAgent: true });
    expect(st.closing).toBe(walletCard(A));
    expect(st.closing).not.toBe(1);
  });

  it('clean wallet: no internal adjustments, excludes other users', async () => {
    const st = await loadPeriodStatement(B, '2026-08-01', '2026-08-31');
    tieOut(st);
    expect(st.rows).toHaveLength(3);
    expect(st.closing).toBe(walletCard(B));
    expect(st.opening).toBe(0);
    expect(st.reconciliation!.internalAdjustments).toBe(0);
  });

  it('empty wallet: zero everything', async () => {
    const st = await loadPeriodStatement(C, '2026-01-01', '2026-12-31');
    tieOut(st);
    expect([st.rows.length, st.opening, st.closing, st.totalIn, st.totalOut]).toEqual([0, 0, 0, 0, 0]);
  });
});
