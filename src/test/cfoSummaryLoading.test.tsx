import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), hero: vi.fn(), report: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('@/components/cfo/HeroCard', () => ({ HeroCard: (props: unknown) => { mocks.hero(props); return null; } }));
vi.mock('@/components/cfo/MoneyDrilldownReport', () => ({ allTime: () => ({ from: '2000-01-01', to: '2026-10-23' }) }));
vi.mock('@/components/cfo/MoneyReceivedReport', () => ({ MoneyReceivedReport: (props: unknown) => { mocks.report(props); return null; } }));
vi.mock('@/components/cfo/MoneyPaidOutReport', () => ({ MoneyPaidOutReport: (props: unknown) => { mocks.report(props); return null; } }));
import { MoneyReceivedCard } from '@/components/cfo/MoneyReceivedCard';
import { MoneyPaidOutCard } from '@/components/cfo/MoneyPaidOutCard';
import { usePayablesTotal, usePayablesBreakdown, usePayablesContractSchedule } from '@/hooks/usePayables';

function context() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('CFO card summaries independent of source details', () => {
  it.each([
    { Card: MoneyReceivedCard, kind: 'received', fn: 'get_cfo_money_received', field: 'total_received', status: 'approved', type: 'Operational float' },
    { Card: MoneyPaidOutCard, kind: 'paid_out', fn: 'get_cfo_money_paid_out', field: 'total_paid', status: 'confirmed', type: 'Wallet withdrawal' },
  ])('keeps $kind summary, date window and source reconciliation unchanged', async ({ Card, kind, fn, field, status, type }) => {
    let release: (value: unknown) => void = () => {};
    const sources = new Promise(resolve => { release = resolve; });
    mocks.rpc.mockImplementation((name: string) => name === fn ? Promise.resolve({ data: [{ [field]: 5000, total_count: 5 }], error: null }) : sources);
    const { wrapper, client } = context();
    const view = render(<Card moneyWeHaveTotal={10000} />, { wrapper });
    await waitFor(() => expect(mocks.hero.mock.lastCall?.[0]).toMatchObject({ percentageValue: 5000, percentageTotal: 10000 }));
    expect(mocks.hero.mock.lastCall?.[0].items).toEqual([]);
    expect(mocks.rpc).toHaveBeenCalledWith('get_cfo_money_drilldown_totals', {
      p_kind: kind, p_from: '1999-12-31T21:00:00.000Z', p_to: '2026-10-23T21:00:00.000Z',
      p_status: status, p_method: null, p_type: type, p_person: null,
    });
    await act(async () => release({ data: [{ confirmed_amount: 1000, confirmed_count: 1 }], error: null }));
    await waitFor(() => expect(mocks.hero.mock.lastCall?.[0].items).toHaveLength(5));
    const props = mocks.hero.mock.lastCall?.[0];
    expect(props.percentageValue).toBe(5000);
    await act(async () => props.items[0].onSelect());
    expect(mocks.report.mock.lastCall?.[0]).toMatchObject({ open: true, preset: {
      from: '2000-01-01', to: '2026-10-23', status, type,
      expected: { amount: 1000, count: 1, basis: 'confirmed' },
    } });
    view.unmount(); client.clear();
  });

  it.each([
    { Card: MoneyReceivedCard, fn: 'get_cfo_money_received', field: 'total_received' },
    { Card: MoneyPaidOutCard, fn: 'get_cfo_money_paid_out', field: 'total_paid' },
  ])('retains the $field headline when optional source reads fail', async ({ Card, fn, field }) => {
    mocks.rpc.mockImplementation(async (name: string) => name === fn
      ? { data: [{ [field]: 9876 }], error: null }
      : { data: null, error: { code: '42501', message: 'denied' } });
    const { wrapper, client } = context();
    const view = render(<Card moneyWeHaveTotal={20000} />, { wrapper });
    await waitFor(() => expect(mocks.hero.mock.lastCall?.[0]).toMatchObject({ percentageValue: 9876 }));
    expect(mocks.rpc.mock.calls.filter(c => c[0] === fn)).toHaveLength(1);
    view.unmount(); client.clear();
  });
});

describe('Scoped Payables loading preserves authoritative output', () => {
  it('returns category validation and exact contract periods unchanged', async () => {
    const total = { currency: 'UGX', total: 10000, overdue: 2000, due_today: 500, item_count: 3 };
    const breakdown = { total: 10000, categories: [{ key: 'partner', outstanding: 10000, products: [] }], validation: { categories_total: 10000, authoritative_total: 10000, difference: 0, ties_out: true } };
    const schedule = [{ index: 0, period_start: '2026-10-23', contract_amount: 2500, overdue_included: 2000 }];
    mocks.rpc.mockImplementation(async (name: string) => ({ data: name === 'get_payables_total' ? total : name === 'get_payables_breakdown' ? breakdown : schedule, error: null }));
    const { wrapper, client } = context();
    const view = renderHook(() => ({ total: usePayablesTotal(true), breakdown: usePayablesBreakdown(true, true), schedule: usePayablesContractSchedule('day', 14, true, true) }), { wrapper });
    await waitFor(() => expect(view.result.current.schedule.isSuccess).toBe(true));
    expect(view.result.current.total.data).toEqual(total);
    expect(view.result.current.breakdown.data).toEqual(breakdown);
    expect(view.result.current.schedule.data).toEqual(schedule);
    expect(mocks.rpc).toHaveBeenCalledWith('get_payables_contract_schedule', { p_granularity: 'day', p_periods: 14 });
    view.unmount(); client.clear();
  });

  it.each(['get_payables_total', 'get_payables_breakdown', 'get_payables_contract_schedule'])('does not retry %s permission failures in the approved scope', async (fn) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'denied' } });
    const { wrapper, client } = context();
    const view = renderHook(() => fn === 'get_payables_total' ? usePayablesTotal(true) : fn === 'get_payables_breakdown' ? usePayablesBreakdown(true, true) : usePayablesContractSchedule('day', 7, true, true), { wrapper });
    await waitFor(() => expect(view.result.current.isError).toBe(true));
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(view.result.current.data).toBeUndefined();
    view.unmount(); client.clear();
  });
});