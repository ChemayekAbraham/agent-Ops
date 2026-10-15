import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
// like the real client, rpc only works when called on the client itself (a detached call has no `this`)
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rest: {},
    rpc(this: { rest?: unknown } | undefined, ...a: unknown[]) {
      if (!this?.rest) throw new TypeError("Cannot read properties of undefined (reading 'rest')");
      return rpcMock(...a);
    },
  },
}));

import { useNewTenantFirst7, useNewTenantFirst7Payments } from './useNewTenantFirst7';

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

const rawRow = {
  rent_request_id: 'rr-1', tenant_id: 't-1', tenant_name: 'Amina', tenant_phone: '0772000111', agent_id: 'a-1', agent_name: 'Joy',
  landlord_paid_on: '2026-10-10', day1: '2026-10-11', frequency: 'daily', daily_due: '10000.00', total_repayment: '300000',
  day_paid: ['10000', 0, 5000, 0, 0, 0, 0], day_due: [10000, 10000, 10000, 10000, 10000, 10000, 10000],
  day_state: ['paid', 'missed', 'part', 'missed', 'missed', 'future', 'future'], paid_7d: '15000', expected_to_date: '50000', first_paid_day: 1, row_status: 'behind',
};
const rawSummary = { plans: 1, daily_plans: 1, weekly_plans: 0, status: { on_track: 0, behind: 1, not_started: 0, too_early: 0 }, day1: { started: 1, payers: 1, pct: 100 }, per_day: [], collected: 15000, expected: 50000, collected_pct: 30 };

const answer = () => rpcMock.mockImplementation((fn: string) => Promise.resolve(
  fn === 'am_new_tenant_first7_v2' ? { data: [rawRow], error: null }
    : fn === 'am_new_tenant_first7_summary_v2' ? { data: rawSummary, error: null }
    : fn === 'am_new_tenant_first7_payments' ? { data: [{ collection_id: 'c1', collected_at: '2026-10-11T07:00:00Z', collected_day: '2026-10-11', day_number: '1', amount: '10000', payment_method: 'cash', collection_channel: 'agent_float', agent_id: 'a-1', agent_name: 'Joy' }], error: null }
    : { data: null, error: { message: `unexpected ${fn}` } }));

beforeEach(() => { rpcMock.mockReset(); });

describe('useNewTenantFirst7', () => {
  it('asks the two v2 functions with the same dates and leaves the frequency out for All', async () => {
    answer();
    const { result } = renderHook(() => useNewTenantFirst7({ from: '2026-10-10', to: '2026-10-14', freq: 'all' }), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(rpcMock).toHaveBeenCalledWith('am_new_tenant_first7_v2', { p_from: '2026-10-10', p_to: '2026-10-14' });
    expect(rpcMock).toHaveBeenCalledWith('am_new_tenant_first7_summary_v2', { p_from: '2026-10-10', p_to: '2026-10-14' });
  });

  it('sends the frequency for Daily and Weekly', async () => {
    answer();
    const { result } = renderHook(() => useNewTenantFirst7({ from: '2026-10-10', to: '2026-10-14', freq: 'weekly' }), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(rpcMock).toHaveBeenCalledWith('am_new_tenant_first7_v2', { p_from: '2026-10-10', p_to: '2026-10-14', p_frequency: 'weekly' });
    expect(rpcMock).toHaveBeenCalledWith('am_new_tenant_first7_summary_v2', { p_from: '2026-10-10', p_to: '2026-10-14', p_frequency: 'weekly' });
  });

  it('returns the rows and the summary as numbers, and never changes a state or status the server sent', async () => {
    answer();
    const { result } = renderHook(() => useNewTenantFirst7({ from: '2026-10-10', to: '2026-10-14', freq: 'all' }), { wrapper });
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(result.current.rows[0]).toMatchObject({
      daily_due: 10000, total_repayment: 300000, day_paid: [10000, 0, 5000, 0, 0, 0, 0], paid_7d: 15000, expected_to_date: 50000,
      day_state: ['paid', 'missed', 'part', 'missed', 'missed', 'future', 'future'], row_status: 'behind', first_paid_day: 1,
    });
    expect(result.current.summary).toMatchObject({ plans: 1, collected: 15000, expected: 50000, collected_pct: 30 });
    expect(result.current.error).toBeNull();
  });

  it('asks again when the range or the frequency changes (a new query for each)', async () => {
    answer();
    const { result, rerender } = renderHook((p: { from: string; freq: 'all' | 'daily' }) => useNewTenantFirst7({ from: p.from, to: '2026-10-14', freq: p.freq }), { wrapper, initialProps: { from: '2026-10-10', freq: 'all' } });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(rpcMock).toHaveBeenCalledTimes(2);
    rerender({ from: '2026-10-12', freq: 'daily' });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('am_new_tenant_first7_v2', { p_from: '2026-10-12', p_to: '2026-10-14', p_frequency: 'daily' }));
    expect(rpcMock).toHaveBeenCalledTimes(4);
  });

  it('surfaces an error from either function', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: '42501', message: 'Not authorized' } });
    const { result } = renderHook(() => useNewTenantFirst7({ from: '2026-10-10', to: '2026-10-14', freq: 'all' }), { wrapper });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect((result.current.error as unknown as { code: string }).code).toBe('42501');
    expect(result.current.rows).toEqual([]);
    expect(result.current.summary).toBeNull();
  });

  it('refetch asks both functions again', async () => {
    answer();
    const { result } = renderHook(() => useNewTenantFirst7({ from: '2026-10-10', to: '2026-10-14', freq: 'all' }), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    rpcMock.mockClear();
    result.current.refetch();
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(2));
  });

  it('never writes: it only calls the three read functions', async () => {
    answer();
    const { result } = renderHook(() => useNewTenantFirst7({ from: '2026-10-10', to: '2026-10-14', freq: 'all' }), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    for (const [fn] of rpcMock.mock.calls) expect(['am_new_tenant_first7_v2', 'am_new_tenant_first7_summary_v2', 'am_new_tenant_first7_payments']).toContain(fn);
  });
});

describe('useNewTenantFirst7Payments', () => {
  it('does nothing until a Rent Plan is chosen', () => {
    answer();
    const { result } = renderHook(() => useNewTenantFirst7Payments(null), { wrapper });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.payments).toEqual([]);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('loads that plan\'s payments with numbers for the amount and day', async () => {
    answer();
    const { result } = renderHook(() => useNewTenantFirst7Payments('rr-1'), { wrapper });
    await waitFor(() => expect(result.current.payments).toHaveLength(1));
    expect(rpcMock).toHaveBeenCalledWith('am_new_tenant_first7_payments', { p_rent_request_id: 'rr-1' });
    expect(result.current.payments[0]).toMatchObject({ collection_id: 'c1', day_number: 1, amount: 10000, payment_method: 'cash', collection_channel: 'agent_float', agent_name: 'Joy' });
  });

  it('keeps each plan\'s payments apart', async () => {
    answer();
    const { result, rerender } = renderHook(({ id }: { id: string }) => useNewTenantFirst7Payments(id), { wrapper, initialProps: { id: 'rr-1' } });
    await waitFor(() => expect(result.current.payments).toHaveLength(1));
    rerender({ id: 'rr-2' });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('am_new_tenant_first7_payments', { p_rent_request_id: 'rr-2' }));
  });

  it('surfaces an error', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { result } = renderHook(() => useNewTenantFirst7Payments('rr-1'), { wrapper });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.payments).toEqual([]);
  });
});
