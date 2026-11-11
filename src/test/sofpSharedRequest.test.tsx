import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock('@/hooks/useAuthenticatedPoll', () => ({ useAuthenticatedAudience: () => true }));

import {
  fetchStatementOfFinancialPosition, resetSofpRequestCache,
  SOFP_CACHE_TTL_MS, SOFP_CLIENT_TIMEOUT_CODE, SOFP_CLIENT_TIMEOUT_MS,
} from '@/lib/sofpRequest';
import { useCFOOverviewData } from '@/hooks/useCFOOverviewData';
import { useStatementOfCashFlows } from '@/hooks/useStatementOfCashFlows';

const SHEET = {
  as_at: '2026-11-11T10:00:00Z',
  assets: { current: [{ label: 'Cash and Bank Balances', value: 100, source: 'general_ledger trial balance — account A1' }], non_current: [] },
  liabilities: { total: 40 },
  balance_check: { balanced: true },
};

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const sofpCalls = () => mocks.rpc.mock.calls.filter(c => c[0] === 'get_statement_of_financial_position');

beforeEach(() => {
  vi.clearAllMocks();
  resetSofpRequestCache();
  mocks.rpc.mockImplementation(async () => ({ data: SHEET, error: null }));
});
afterEach(() => { vi.useRealTimers(); });

describe('shared Balance Sheet statement request', () => {
  it('runs one server request for callers that ask at the same time', async () => {
    const d = deferred<{ data: unknown; error: null }>();
    mocks.rpc.mockImplementation(() => d.promise);
    const a = fetchStatementOfFinancialPosition();
    const b = fetchStatementOfFinancialPosition();
    d.resolve({ data: SHEET, error: null });
    const [ra, rb] = await Promise.all([a, b]);
    expect(sofpCalls()).toHaveLength(1);
    expect(sofpCalls()[0][1]).toEqual({});
    expect(ra.data).toBe(SHEET);
    expect(rb.data).toBe(SHEET);
  });

  it('reuses a finished result inside the freshness window and fetches again after it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T10:00:00Z'));
    await fetchStatementOfFinancialPosition();
    await fetchStatementOfFinancialPosition();
    expect(sofpCalls()).toHaveLength(1);
    vi.setSystemTime(new Date(Date.now() + SOFP_CACHE_TTL_MS + 1));
    await fetchStatementOfFinancialPosition();
    expect(sofpCalls()).toHaveLength(2);
  });

  it('Refresh (force) ignores the cached result', async () => {
    await fetchStatementOfFinancialPosition();
    await fetchStatementOfFinancialPosition({ force: true });
    expect(sofpCalls()).toHaveLength(2);
  });

  it('Refresh joins a request already in flight instead of starting a second one', async () => {
    const d = deferred<{ data: unknown; error: null }>();
    mocks.rpc.mockImplementation(() => d.promise);
    const a = fetchStatementOfFinancialPosition();
    const b = fetchStatementOfFinancialPosition({ force: true });
    d.resolve({ data: SHEET, error: null });
    await Promise.all([a, b]);
    expect(sofpCalls()).toHaveLength(1);
  });

  it('keeps past dates separate and passes p_as_at unchanged', async () => {
    await fetchStatementOfFinancialPosition();
    await fetchStatementOfFinancialPosition({ asAtIso: '2026-10-31T20:59:59.999Z' });
    await fetchStatementOfFinancialPosition({ asAtIso: '2026-10-31T20:59:59.999Z' });
    expect(sofpCalls().map(c => c[1])).toEqual([{}, { p_as_at: '2026-10-31T20:59:59.999Z' }]);
  });

  it('does not cache a failure and keeps the server error code', async () => {
    mocks.rpc.mockImplementationOnce(async () => ({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } }));
    await expect(fetchStatementOfFinancialPosition()).rejects.toMatchObject({ code: '57014', message: 'canceling statement due to statement timeout' });
    const ok = await fetchStatementOfFinancialPosition();
    expect(ok.data).toBe(SHEET);
    expect(sofpCalls()).toHaveLength(2);
  });

  it('gives up after the client time limit with a recognisable code, and does not cache it', async () => {
    vi.useFakeTimers();
    mocks.rpc.mockImplementationOnce(() => new Promise(() => {}));
    const p = fetchStatementOfFinancialPosition();
    const check = expect(p).rejects.toMatchObject({ code: SOFP_CLIENT_TIMEOUT_CODE });
    await vi.advanceTimersByTimeAsync(SOFP_CLIENT_TIMEOUT_MS + 1);
    await check;
    vi.useRealTimers();
    await fetchStatementOfFinancialPosition();
    expect(sofpCalls()).toHaveLength(2);
  });

  it('returns the server figures untouched', async () => {
    const r = await fetchStatementOfFinancialPosition();
    expect(r.data).toEqual(SHEET);
  });
});

describe('CFO Overview cash cards share the Balance Sheet request', () => {
  it('a Balance Sheet request in flight serves the cards without a second server run', async () => {
    const d = deferred<{ data: unknown; error: null }>();
    mocks.rpc.mockImplementation((name: string) => (name === 'get_statement_of_financial_position'
      ? d.promise
      : Promise.resolve({ data: null, error: null })));
    const fromBalanceSheet = fetchStatementOfFinancialPosition();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const view = renderHook(() => useCFOOverviewData({ cashVisible: true }), { wrapper });
    d.resolve({ data: SHEET, error: null });
    await fromBalanceSheet;
    await waitFor(() => expect(view.result.current.position?.totalCash).toBe(100));
    expect(view.result.current.position?.totalLiabilities).toBe(40);
    expect(sofpCalls()).toHaveLength(1);
  });
});

describe('Cash Flow statement request is held until shown', () => {
  it('makes no fin_cash_flow call while disabled, and one once enabled', async () => {
    const start = new Date('2026-11-01T00:00:00Z');
    const end = new Date('2026-11-11T00:00:00Z');
    const view = renderHook(({ on }) => useStatementOfCashFlows(start, end, on), { initialProps: { on: false } });
    await new Promise(r => setTimeout(r, 0));
    expect(mocks.rpc.mock.calls.filter(c => c[0] === 'fin_cash_flow')).toHaveLength(0);
    expect(view.result.current.loading).toBe(false);
    view.rerender({ on: true });
    await waitFor(() => expect(mocks.rpc.mock.calls.filter(c => c[0] === 'fin_cash_flow')).toHaveLength(1));
  });

  it('still loads straight away for existing callers that pass no flag', async () => {
    renderHook(() => useStatementOfCashFlows(new Date('2026-11-01T00:00:00Z'), new Date('2026-11-11T00:00:00Z')));
    await waitFor(() => expect(mocks.rpc.mock.calls.filter(c => c[0] === 'fin_cash_flow')).toHaveLength(1));
  });
});
