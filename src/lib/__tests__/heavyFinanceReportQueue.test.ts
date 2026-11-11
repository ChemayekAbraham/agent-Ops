import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import type { ReactNode } from 'react';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));

import {
  HEAVY_FINANCE_REPORTS,
  HEAVY_REPORT_SLOW_MESSAGE,
  financeReportErrorMessage,
  heavyFinanceReportQueryOptions,
  isSlowFinanceReportError,
  resetHeavyFinanceReportQueueForTests,
  runHeavyFinanceReport,
} from '@/lib/heavyFinanceReportQueue';
import { useFinIncomeStatement } from '@/hooks/useFinIncomeStatement';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

afterEach(() => {
  resetHeavyFinanceReportQueueForTests();
  rpc.mockReset();
});

describe('heavy finance report queue', () => {
  it('runs one statement at a time and lets the visible report jump the queue', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<{ data: unknown; error: null }>>>();
    const started: string[] = [];
    rpc.mockImplementation((name: string) => {
      started.push(name);
      const gate = deferred<{ data: unknown; error: null }>();
      gates.set(name, gate);
      return gate.promise;
    });

    const balance = runHeavyFinanceReport('fin_balance_sheet', { p_as_at: '2026-11-01' });
    const background = runHeavyFinanceReport('fin_income_statement', { p_from: 'a', p_to: 'b' }, { active: false });
    const visible = runHeavyFinanceReport('fin_cash_flow', { p_from: 'a', p_to: 'b' });

    expect(started).toEqual(['fin_balance_sheet']);

    gates.get('fin_balance_sheet')!.resolve({ data: { sheet: 1 }, error: null });
    await expect(balance).resolves.toEqual({ sheet: 1 });
    await Promise.resolve();
    expect(started).toEqual(['fin_balance_sheet', 'fin_cash_flow']);

    gates.get('fin_cash_flow')!.resolve({ data: { flow: 2 }, error: null });
    await expect(visible).resolves.toEqual({ flow: 2 });
    await Promise.resolve();
    expect(started).toEqual(['fin_balance_sheet', 'fin_cash_flow', 'fin_income_statement']);

    gates.get('fin_income_statement')!.resolve({ data: { income: 3 }, error: null });
    await expect(background).resolves.toEqual({ income: 3 });
  });

  it('queues the cash summary and ledger sums and shares one zero-argument call', async () => {
    expect(HEAVY_FINANCE_REPORTS).toEqual(expect.arrayContaining([
      'get_platform_cash_summary',
      'get_financial_statement_ledger_sums',
    ]));
    const gate = deferred<{ data: { total_revenue: 1 }; error: null }>();
    rpc.mockReturnValue(gate.promise);
    const first = runHeavyFinanceReport('get_platform_cash_summary', {});
    const second = runHeavyFinanceReport('get_platform_cash_summary', {});
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]).toEqual(['get_platform_cash_summary']);
    gate.resolve({ data: { total_revenue: 1 }, error: null });
    await expect(Promise.all([first, second])).resolves.toEqual([{ total_revenue: 1 }, { total_revenue: 1 }]);
  });

  it('shares one in-flight request for the same statement and arguments', async () => {
    const gate = deferred<{ data: { shared: true }; error: null }>();
    rpc.mockReturnValue(gate.promise);
    const first = runHeavyFinanceReport('fin_income_statement', { p_to: '2', p_from: '1' });
    const second = runHeavyFinanceReport('fin_income_statement', { p_from: '1', p_to: '2' });
    expect(rpc).toHaveBeenCalledTimes(1);
    gate.resolve({ data: { shared: true }, error: null });
    await expect(Promise.all([first, second])).resolves.toEqual([{ shared: true }, { shared: true }]);
  });

  it('drops a report that has not started when its tab is closed', async () => {
    const gate = deferred<{ data: { ok: true }; error: null }>();
    rpc.mockImplementation((name: string) => name === 'fin_balance_sheet' ? gate.promise : Promise.resolve({ data: { skipped: true }, error: null }));
    const controller = new AbortController();
    const running = runHeavyFinanceReport('fin_balance_sheet', { p_as_at: '2026-11-01' });
    const waiting = runHeavyFinanceReport(
      'get_statement_of_cash_flows',
      { p_from: 'a', p_to: 'b' },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    gate.resolve({ data: { ok: true }, error: null });
    await expect(running).resolves.toEqual({ ok: true });
    expect(rpc.mock.calls.map((call) => call[0])).toEqual(['fin_balance_sheet']);
  });

  it('keeps a shared request when only one of the callers leaves', async () => {
    const gate = deferred<{ data: { kept: true }; error: null }>();
    rpc.mockReturnValue(gate.promise);
    const controller = new AbortController();
    const leaving = runHeavyFinanceReport('fin_cash_flow', { p_from: 'a', p_to: 'b' }, { signal: controller.signal });
    const staying = runHeavyFinanceReport('fin_cash_flow', { p_from: 'a', p_to: 'b' });
    controller.abort();
    gate.resolve({ data: { kept: true }, error: null });
    await expect(staying).resolves.toEqual({ kept: true });
    await expect(leaving).resolves.toEqual({ kept: true });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('names timeouts and 5xx as a slow report and does not retry them', () => {
    expect(heavyFinanceReportQueryOptions).toMatchObject({
      retry: false,
      retryOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      refetchOnReconnect: false,
      staleTime: 5 * 60 * 1000,
      refetchInterval: false,
    });
    expect(isSlowFinanceReportError({ code: '57014', message: 'canceling statement due to statement timeout' })).toBe(true);
    expect(isSlowFinanceReportError({ status: 503, message: 'upstream connect error' })).toBe(true);
    expect(isSlowFinanceReportError({ code: '500', message: 'Internal Server Error' })).toBe(true);
    expect(isSlowFinanceReportError({ message: 'Bad Gateway' })).toBe(true);
    expect(isSlowFinanceReportError({ code: '42501', message: 'Not authorised' })).toBe(false);
    expect(financeReportErrorMessage({ code: '57014', message: 'canceling statement due to statement timeout' })).toBe(HEAVY_REPORT_SLOW_MESSAGE);
    expect(financeReportErrorMessage({ status: 502, message: 'gateway' })).toBe(HEAVY_REPORT_SLOW_MESSAGE);
    expect(financeReportErrorMessage({ code: '42501', message: 'Not authorised' })).toBe('Not authorised');
  });

  it('keeps the slow income-statement error when the tab is opened again', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 0, gcTime: Infinity } } });
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
    const start = new Date('2026-10-01T00:00:00Z');
    const end = new Date('2026-11-01T00:00:00Z');
    const first = renderHook(
      ({ open }) => useFinIncomeStatement(start, end, { enabled: open }),
      { wrapper, initialProps: { open: true } },
    );
    await waitFor(() => expect(first.result.current.error).toBe(HEAVY_REPORT_SLOW_MESSAGE));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    first.rerender({ open: false });
    first.rerender({ open: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(first.result.current.error).toBe(HEAVY_REPORT_SLOW_MESSAGE);
    expect(rpc).toHaveBeenCalledTimes(1);
    first.unmount();
    client.clear();
  });
});
