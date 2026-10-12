import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpc = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

import { CLOCK_CHUNK, useAgentMonitoringClock } from './useAgentMonitoringClock';

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

const clockRow = (id: string, bucket = 'counting') => ({
  rent_request_id: id, bucket, landlord_paid_count: 1, landlord_paid_total: 1, landlord_paid_dates_estimated: 0,
  first_landlord_paid_on: '2026-09-01', last_landlord_paid_on: '2026-09-01', clock_start: '2026-09-02',
  clock_end: '2026-10-01', current_start: '2026-09-02', shift_days: 0,
});
const arrearsRow = (id: string) => ({
  rent_request_id: id, bucket: 'counting', cadence: 'daily', unit: 'day', clock_start: '2026-09-02',
  expected_to_date: 10, paid_to_date: 5, arrears: 5, days_behind: 0, days_ahead: 0, periods_behind: 0, periods_ahead: 0,
});

describe('useAgentMonitoringClock', () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockImplementation(async (fn: string, args: { p_rent_request_ids: string[] }) => ({
      data: args.p_rent_request_ids.map((id) => (fn === 'am_plan_clock' ? clockRow(id) : arrearsRow(id))),
      error: null,
    }));
  });

  it('batches plan ids into chunks, one pair of calls per chunk, and joins the two readings', async () => {
    const ids = Array.from({ length: CLOCK_CHUNK + 20 }, (_, i) => `plan-${i}`);
    const { result } = renderHook(() => useAgentMonitoringClock(ids, new Date(2026, 8, 10)), { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(rpc).toHaveBeenCalledTimes(4); // 2 chunks x (clock + arrears), never one call per plan
    const clockCalls = rpc.mock.calls.filter(([fn]) => fn === 'am_plan_clock');
    expect(clockCalls.map(([, a]) => (a as { p_rent_request_ids: string[] }).p_rent_request_ids.length)).toEqual([CLOCK_CHUNK, 20]);
    const arrearsCall = rpc.mock.calls.find(([fn]) => fn === 'am_plan_arrears');
    expect(arrearsCall?.[1]).toMatchObject({ p_as_at: '2026-09-10' });

    expect(result.current.readings.size).toBe(ids.length);
    expect(result.current.readings.get('plan-3')?.arrears.arrears).toBe(5);
    expect(result.current.readings.get('plan-3')?.clock.clock_start).toBe('2026-09-02');
  });

  it('makes no call and is ready when there are no plans', () => {
    const { result } = renderHook(() => useAgentMonitoringClock([], new Date(2026, 8, 10)), { wrapper });
    expect(result.current.ready).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reports an error instead of readings when the server refuses', async () => {
    rpc.mockImplementation(async () => ({ data: null, error: { message: 'Not authorized' } }));
    const { result } = renderHook(() => useAgentMonitoringClock(['p1'], new Date(2026, 8, 10)), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.ready).toBe(false);
    expect(result.current.readings.size).toBe(0);
  });
});
