import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory ledger + wallet used by the mocked database client.
type Leg = { id: string; user_id: string; transaction_date: string; amount: number; direction: 'cash_in' | 'cash_out'; category: string; ledger_scope: string };
const db: { legs: Leg[]; wallet: any } = { legs: [], wallet: null };

function ledgerQuery() {
  const filters: ((r: any) => boolean)[] = [];
  let lo = 0, hi = Infinity;
  const q: any = {
    select: () => q,
    eq: (k: string, v: any) => (filters.push((r) => r[k] === v), q),
    in: (k: string, vs: any[]) => (filters.push((r) => vs.includes(r[k])), q),
    gte: (k: string, v: string) => (filters.push((r) => r[k] >= v), q),
    lte: (k: string, v: string) => (filters.push((r) => r[k] <= v), q),
    gt: (k: string, v: string) => (filters.push((r) => r[k] > v), q),
    lt: (k: string, v: string) => (filters.push((r) => r[k] < v), q),
    order: () => q,
    range: (a: number, b: number) => {
      lo = a; hi = b;
      const rows = db.legs.filter((r) => filters.every((f) => f(r)))
        .sort((x, y) => x.transaction_date.localeCompare(y.transaction_date) || x.id.localeCompare(y.id));
      return Promise.resolve({ data: rows.slice(lo, hi + 1), error: null });
    },
  };
  return q;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => t === 'wallets'
      ? { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: db.wallet, error: null }) }) }) }
      : ledgerQuery(),
  },
}));
vi.mock('@/lib/customerWalletHistory', () => ({
  applyCustomerWalletLedgerFilters: (q: any) => q,
  isCustomerWalletLedgerEntryVisible: () => true,
}));
vi.mock('@/lib/walletRequisitionLabel', () => ({ requisitionEntryLabel: () => null }));
vi.mock('@/assets/welile-logo.png', () => ({ default: '' }));

import { loadPeriodStatement, reconciliationLines } from './walletPeriodStatement';

const U = 'user-1';
let n = 0;
const leg = (iso: string, amount: number, direction: 'cash_in' | 'cash_out', user_id = U, ledger_scope = 'wallet'): Leg =>
  ({ id: `L${String(++n).padStart(4, '0')}`, user_id, transaction_date: iso, amount, direction, category: 'deposit', ledger_scope });

// Independent oracle: the balance at the end of a Kampala day = current − net of legs after it.
const current = 5_000_000;
const endIso = (d: string) => new Date(`${d}T23:59:59.999+03:00`).toISOString();
const startIso = (d: string) => new Date(`${d}T00:00:00+03:00`).toISOString();
const net = (ls: Leg[]) => ls.reduce((s, l) => s + (l.direction === 'cash_in' ? l.amount : -l.amount), 0);
const mine = () => db.legs.filter((l) => l.user_id === U && ['wallet', 'bridge'].includes(l.ledger_scope));

function expected(from: string, to: string) {
  const inRange = mine().filter((l) => l.transaction_date >= startIso(from) && l.transaction_date <= endIso(to));
  const cur = Number(db.wallet?.balance) || Number(db.wallet?.withdrawable_balance ?? 0) + Number(db.wallet?.float_balance ?? 0);
  const closing = cur - net(mine().filter((l) => l.transaction_date > endIso(to)));
  return {
    count: inRange.length,
    totalIn: inRange.filter((l) => l.direction === 'cash_in').reduce((s, l) => s + l.amount, 0),
    totalOut: inRange.filter((l) => l.direction === 'cash_out').reduce((s, l) => s + l.amount, 0),
    closing, opening: closing - net(inRange),
  };
}

beforeEach(() => {
  n = 0;
  db.wallet = { balance: current, withdrawable_balance: 4_000_000, float_balance: 1_000_000 };
  db.legs = [
    leg('2026-06-10T08:00:00Z', 1_000_000, 'cash_in'),
    leg('2026-06-30T20:59:59.999Z', 200_000, 'cash_out'),  // 23:59:59 Kampala 30 Jun
    leg('2026-06-30T21:00:00Z', 300_000, 'cash_in'),       // 00:00 Kampala 1 Jul — belongs to July
    leg('2026-07-15T10:00:00Z', 50_000, 'cash_out'),
    leg('2026-07-31T12:00:00Z', 2_500_000, 'cash_in'),
    leg('2026-08-01T06:00:00Z', 700_000, 'cash_out'),
    leg('2026-08-02T06:00:00Z', 125_000, 'cash_in'),
    leg('2026-08-03T06:00:00Z', 90_000, 'cash_out'),
    leg('2026-08-20T06:00:00Z', 1_800_000, 'cash_out'),
    leg('2026-09-05T06:00:00Z', 400_000, 'cash_in'),
    leg('2026-08-02T07:00:00Z', 9_999_999, 'cash_in', 'someone-else'), // other user
    leg('2026-08-02T07:30:00Z', 8_888_888, 'cash_in', U, 'platform'),  // not a wallet leg
  ];
});

async function check(from: string, to: string) {
  const st = await loadPeriodStatement(U, from, to);
  const e = expected(from, to);
  expect(st.rows).toHaveLength(e.count);
  expect(st.totalIn).toBe(e.totalIn);
  expect(st.totalOut).toBe(e.totalOut);
  expect(st.closing).toBe(e.closing);
  expect(st.opening).toBe(e.opening);
  expect(st.opening + st.totalIn - st.totalOut).toBe(st.closing);
  expect(st.rows.length ? st.rows[st.rows.length - 1].balance : st.opening).toBe(st.closing);
  return st;
}

describe('loadPeriodStatement', () => {
  it('short range (3 days)', async () => {
    const st = await check('2026-08-01', '2026-08-03');
    expect(st.rows).toHaveLength(3);
    expect(st.totalIn).toBe(125_000);
    expect(st.totalOut).toBe(790_000);
  });

  it('single day with no activity keeps opening = closing', async () => {
    const st = await check('2026-08-10', '2026-08-10');
    expect(st.rows).toHaveLength(0);
    expect(st.opening).toBe(st.closing);
  });

  it('full month respects Kampala day boundaries', async () => {
    const st = await check('2026-07-01', '2026-07-31');
    expect(st.rows).toHaveLength(3); // includes 00:00 Kampala 1 Jul, excludes 23:59 30 Jun
    expect(st.totalIn).toBe(2_800_000);
    expect(st.totalOut).toBe(50_000);
  });

  it('multi-month range', async () => {
    const st = await check('2026-06-01', '2026-08-31');
    expect(st.rows).toHaveLength(9);
  });

  it('range ending today closes on the wallet balance', async () => {
    const st = await check('2026-06-01', '2026-09-30');
    expect(st.closing).toBe(current);
  });

  it('adjacent periods chain: closing of one = opening of the next', async () => {
    const jun = await check('2026-06-01', '2026-06-30');
    const jul = await check('2026-07-01', '2026-07-31');
    const aug = await check('2026-08-01', '2026-08-31');
    expect(jul.opening).toBe(jun.closing);
    expect(aug.opening).toBe(jul.closing);
    const all = await check('2026-06-01', '2026-08-31');
    expect(all.opening).toBe(jun.opening);
    expect(all.closing).toBe(aug.closing);
    expect(all.totalIn).toBe(jun.totalIn + jul.totalIn + aug.totalIn);
    expect(all.rows.length).toBe(jun.rows.length + jul.rows.length + aug.rows.length);
  });

  it('paginates past 1,000 rows without losing totals', async () => {
    for (let i = 0; i < 2_345; i++) db.legs.push(leg(`2026-08-15T0${i % 10}:00:00.${String(i % 1000).padStart(3, '0')}Z`, 1_000, i % 3 ? 'cash_in' : 'cash_out'));
    const st = await check('2026-08-01', '2026-08-31');
    expect(st.rows.length).toBe(4 + 2_345);
  });

  it('falls back to withdrawable + float when balance is empty', async () => {
    db.wallet = { balance: 0, withdrawable_balance: 4_000_000, float_balance: 1_000_000 };
    const st = await check('2026-06-01', '2026-09-30');
    expect(st.closing).toBe(current);
  });

  it('reconciliation identifies internal adjustments not listed as transactions', async () => {
    const st = await check('2026-08-01', '2026-08-31');
    const r = st.reconciliation!;
    const listedAll = net(mine());
    expect(r.internalAdjustments).toBe(current - listedAll);
    expect(r.visibleBeforePeriod + r.internalAdjustments).toBe(st.opening);
    expect(r.currentBalance - r.netAfterPeriod).toBe(st.closing);
    expect(r.periodCount + r.beforeCount + r.afterCount).toBe(mine().length);
    expect(reconciliationLines(st)).toHaveLength(8);
  });

  it('reports no adjustment when the balance equals listed transactions', async () => {
    db.wallet = { balance: net(mine()) };
    const st = await check('2026-07-01', '2026-07-31');
    expect(st.reconciliation!.internalAdjustments).toBe(0);
    expect(reconciliationLines(st)[7][2]).toMatch(/^None/);
  });
});
