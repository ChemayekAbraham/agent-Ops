import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), ranges: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from } }));
import { useActualMoneyHeld } from '@/hooks/useActualMoneyHeld';
import { useCFOOverviewData } from '@/hooks/useCFOOverviewData';
import { useReceivablesTotal } from '@/hooks/useReceivables';
import { cfoReportRetry } from '@/hooks/cfoReportRetry';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function setup<T>(hook: () => T) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, ...renderHook(hook, { wrapper }) };
}
const bankRow = (id: string, status: string, amount: number, location = 'bank') => ({
  id, deposit_request_id: id, status, amount, created_at: '2026-10-23T06:00:00Z', verified_at: '2026-10-23T07:00:00Z',
  deposit_requests: { purpose_audit: { cash_location: location } },
});
const verifications = [
  bankRow('first', 'verified', 250), bankRow('first', 'verified', 900),
  bankRow('rejected', 'rejected', 500), bankRow('custody', 'verified', 800, 'cash_at_hand'),
  bankRow('second', 'verified', 100),
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ranges.mockResolvedValue({ data: verifications, error: null });
  mocks.from.mockImplementation(() => {
    const chain: any = {};
    for (const name of ['select', 'order', 'eq', 'gte', 'lt', 'in']) chain[name] = vi.fn(() => chain);
    chain.range = mocks.ranges;
    return chain;
  });
  mocks.rpc.mockImplementation(async (name: string) => ({ data: {
    get_phone_platform_reconciliation: { mtn_balance: 1000, airtel_balance: 2000 },
    get_cash_at_hand_total: { cash_at_hand_total: 800 },
    get_money_at_bank_reconciliation: { banked_cash_reference: 350, money_at_bank_total: 700, banked_cash_reference_count: 2, computed_at: '2026-10-23T07:05:00Z' },
    get_wallet_totals: { total_balance: 12345, total_float: 6789 },
    get_receivables_total: { total: 43210, categories: [{ key: 'rent', label: 'Rent', outstanding: 43210, item_count: 4 }] },
    get_statement_of_financial_position: { assets: { current: [] }, liabilities: { total: 0 } },
    get_treasury_cash_position: { a1_cash_and_bank: 100, a5_cash_in_transit: 50, total_cash: 150, lines: [{ category: 'partner_funding', net: 150, entry_count: 1 }] },
    partner_ops_report_totals: { total_aum: 1000, total_portfolios: 3 },
  }[name], error: null }));
});

describe('CFO independent loading and unchanged reconciliation', () => {
  it('starts the verification scan before the phone response and waits for the cross-check', async () => {
    const phone = deferred<any>();
    const scan = deferred<any>();
    const original = mocks.rpc.getMockImplementation();
    mocks.rpc.mockImplementation((name: string) => name === 'get_phone_platform_reconciliation' ? phone.promise : original?.(name));
    mocks.ranges.mockReturnValue(scan.promise);
    const { result, unmount, client } = setup(() => useActualMoneyHeld());
    await waitFor(() => expect(mocks.ranges).toHaveBeenCalledWith(0, 999));
    expect(result.current.data).toBeUndefined();
    await act(async () => phone.resolve({ data: { mtn_balance: 1000, airtel_balance: 2000 }, error: null }));
    expect(result.current.data).toBeUndefined();
    await act(async () => scan.resolve({ data: verifications, error: null }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      mtn: 1000, airtel: 2000, cashAtHand: 800, custodyNotConfirmedBanked: 800,
      bankedCash: 350, bankReconciliation: 700, total: 3350,
      bankedCashCount: 2, bankedComputedAt: '2026-10-23T07:05:00Z', bankedLastMovementAt: '2026-10-23T07:00:00Z',
      finOpsBankedCash: 350, finOpsBankedCount: 2, bankedDifference: 0, bankedInSync: true,
      agentFloatHeld: 6789, outsideBankHeld: 3800,
    });
    unmount(); client.clear();
  });

  it('retains discrepancy and latest-per-deposit rules across ordered pages', async () => {
    mocks.ranges.mockResolvedValueOnce({ data: [...verifications, ...Array.from({ length: 995 }, (_, i) => bankRow(`ignored-${i}`, 'rejected', 900))], error: null })
      .mockResolvedValueOnce({ data: [bankRow('first', 'verified', 5000), bankRow('third', 'verified', 50)], error: null });
    const { result, unmount, client } = setup(() => useActualMoneyHeld());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.ranges.mock.calls).toEqual([[0, 999], [1000, 1999]]);
    expect(result.current.data).toMatchObject({ total: 3350, finOpsBankedCash: 400, finOpsBankedCount: 3, bankedDifference: 50, bankedInSync: false });
    unmount(); client.clear();
  });

  it('does not silently report reconciliation success when verification fails', async () => {
    mocks.ranges.mockResolvedValue({ data: null, error: { code: '42501', message: 'denied' } });
    const { result, unmount, client } = setup(() => useActualMoneyHeld());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(mocks.ranges).toHaveBeenCalledTimes(1);
    unmount(); client.clear();
  });

  it('shares the receivables total with Home and skips closed/unused detail requests', async () => {
    const { result, unmount, client } = setup(() => ({ overview: useCFOOverviewData({ cashVisible: false }), home: useReceivablesTotal() }));
    await waitFor(() => expect(result.current.home.isSuccess).toBe(true));
    expect(result.current.overview.receivables).toEqual({ totalReceivables: 43210, receivablesCategories: [{ key: 'rent', label: 'Rent', outstanding: 43210, item_count: 4 }] });
    expect(mocks.rpc.mock.calls.map(c => c[0])).toEqual(['get_receivables_total']);
    expect(mocks.from).not.toHaveBeenCalled();
    unmount(); client.clear();
  });

  it('loads all cash-source reconciliation lines on opening, with treasury and partner reads parallel', async () => {
    const treasury = deferred<any>();
    const original = mocks.rpc.getMockImplementation();
    mocks.rpc.mockImplementation((name: string) => name === 'get_treasury_cash_position' ? treasury.promise : original?.(name));
    const view = setup(() => useCFOOverviewData({ cashVisible: false, cashDetails: true }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('partner_ops_report_totals', {}));
    expect(view.result.current.platformCash).toBeUndefined();
    await act(async () => treasury.resolve({ data: { a1_cash_and_bank: 100, a5_cash_in_transit: 50, total_cash: 150, lines: [{ category: 'partner_funding', net: 150, entry_count: 1 }] }, error: null }));
    await waitFor(() => expect(view.result.current.platformCash).toBeDefined());
    expect(view.result.current.platformCash).toMatchObject({ a1: 100, a5: 50, totalCash: 150, totalIn: 1000, totalOut: 850 });
    expect(view.result.current.platformCash?.positions.map(p => p.value)).toEqual([150, 0]);
    view.unmount(); view.client.clear();
  });

  it('shares wallet reads while retaining distinct total balance and float values', async () => {
    const { result, unmount, client } = setup(() => ({ actual: useActualMoneyHeld(), overview: useCFOOverviewData({ cashDetails: true }) }));
    await waitFor(() => expect(result.current.actual.isSuccess && !!result.current.overview.liabilities).toBe(true));
    expect(mocks.rpc.mock.calls.filter(c => c[0] === 'get_wallet_totals')).toHaveLength(1);
    expect(result.current.actual.data?.agentFloatHeld).toBe(6789);
    expect(result.current.overview.liabilities?.tenantFunds).toBe(12345);
    unmount(); client.clear();
  });

  it('does not retry deterministic report failures, but bounds transient retries at two', () => {
    expect(cfoReportRetry(0, { code: '57014' })).toBe(false);
    expect(cfoReportRetry(0, { code: '42501' })).toBe(false);
    expect(cfoReportRetry(1, { message: 'gateway' })).toBe(true);
    expect(cfoReportRetry(2, { message: 'gateway' })).toBe(false);
  });
});