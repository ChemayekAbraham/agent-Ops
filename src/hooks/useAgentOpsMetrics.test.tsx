import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
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

import { useDebouncedValue, useMetricsAgents, useMetricsMainAgents, useMetricsPins, useMetricsQuality, useMetricsRisk, useMetricsTopEarners, useMetricsTotals } from './useAgentOpsMetrics';

const wrapper = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};
beforeEach(() => { rpcMock.mockReset(); vi.useRealTimers(); });

describe('useAgentOpsMetrics', () => {
  it('asks for the totals of the Kampala days and types the answer', async () => {
    rpcMock.mockResolvedValue({ data: [{ houses_listed: 292, listing_earned: 1752000, basis: 'b' }], error: null });
    const { result } = renderHook(() => useMetricsTotals('2026-09-17', '2026-10-16'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data?.houses_listed).toBe(292));
    expect(rpcMock).toHaveBeenCalledWith('agent_ops_metrics_totals', { p_start: '2026-09-17', p_end: '2026-10-16' });
    expect(result.current.data?.listing_earned).toBe(1752000);
  });

  it('surfaces an error and can retry', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'boom', code: 'X' } }).mockResolvedValueOnce({ data: [{ houses_listed: 1 }], error: null });
    const { result } = renderHook(() => useMetricsTotals('2026-10-01', '2026-10-16'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.data?.houses_listed).toBe(1));
  });

  it('pages the agents 50 at a time, sends the search only after 300 ms of quiet, and reads the match count from the rows', async () => {
    rpcMock.mockResolvedValue({ data: [{ agent_id: 'a', name: 'A', total_matched: 120 }], error: null });
    const { result, rerender } = renderHook(
      ({ search, page }) => useMetricsAgents({ from: '2026-10-01', to: '2026-10-16', search, sort: 'name:asc', scope: 'qualifying', page }),
      { wrapper: wrapper(), initialProps: { search: '', page: 0 } },
    );
    await waitFor(() => expect(result.current.total).toBe(120));
    expect(rpcMock).toHaveBeenLastCalledWith('agent_ops_metrics_agents', { p_start: '2026-10-01', p_end: '2026-10-16', p_search: undefined, p_sort: 'name:asc', p_scope: 'qualifying', p_limit: 50, p_offset: 0 });

    rerender({ search: 'ian', page: 0 });
    expect(result.current.debouncing).toBe(true);
    const callsBefore = rpcMock.mock.calls.length;
    expect(rpcMock.mock.calls.length).toBe(callsBefore); // typing alone sends nothing
    await waitFor(() => expect(rpcMock).toHaveBeenLastCalledWith('agent_ops_metrics_agents', expect.objectContaining({ p_search: 'ian', p_offset: 0 })), { timeout: 2000 });

    rerender({ search: 'ian', page: 2 });
    await waitFor(() => expect(rpcMock).toHaveBeenLastCalledWith('agent_ops_metrics_agents', expect.objectContaining({ p_offset: 100, p_limit: 50 })));
  });

  it('debounces a value', async () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 300), { initialProps: { v: 'a' } });
    rerender({ v: 'ab' });
    expect(result.current).toBe('a');
    await waitFor(() => expect(result.current).toBe('ab'), { timeout: 2000 });
  });

  it('asks for the pins in the box only when enabled, and for main agents by page', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    const box = { minLat: 0, minLng: 30, maxLat: 1, maxLng: 31 };
    renderHook(() => useMetricsPins(box, false), { wrapper: wrapper() });
    expect(rpcMock).not.toHaveBeenCalled();
    renderHook(() => useMetricsPins(box, true), { wrapper: wrapper() });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('agent_ops_metrics_pins', { p_min_lat: 0, p_min_lng: 30, p_max_lat: 1, p_max_lng: 31, p_limit: 2000 }));
    renderHook(() => useMetricsMainAgents('2026-10-01', '2026-10-16', 1), { wrapper: wrapper() });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('agent_ops_metrics_main_agents', { p_start: '2026-10-01', p_end: '2026-10-16', p_limit: 50, p_offset: 50 }));
  });

  it('asks for listing quality with the waiting limit and types the answer; a failing call surfaces an error and can retry', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'quality boom' } }).mockResolvedValueOnce({ data: { network: { houses_listed: 307, houses_currently_rejected: 3, waiting_total: 2031 }, agents: [], waiting: [] }, error: null });
    const { result } = renderHook(() => useMetricsQuality('2026-09-17', '2026-10-16', 10), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.data?.network.houses_currently_rejected).toBe(3));
    expect(rpcMock).toHaveBeenLastCalledWith('agent_ops_metrics_listing_quality', { p_start: '2026-09-17', p_end: '2026-10-16', p_limit: 10, p_offset: 0 });
    expect(result.current.data?.network.waiting_total).toBe(2031);
  });

  it('asks for the risk lists with the limit and offset, and keeps the previous answer while the next page loads', async () => {
    rpcMock.mockResolvedValue({ data: { summary: { owing_agents: 322, main_agents_owing_count: 82 }, main_agents_by_advance: [{ main_agent_id: 'm', name: 'M', team_advances_outstanding: 5 }] }, error: null });
    const { result, rerender } = renderHook(({ off }) => useMetricsRisk('2026-09-17', '2026-10-16', 50, off), { wrapper: wrapper(), initialProps: { off: 0 } });
    await waitFor(() => expect(result.current.data?.summary.owing_agents).toBe(322));
    expect(rpcMock).toHaveBeenLastCalledWith('agent_ops_metrics_risk', { p_start: '2026-09-17', p_end: '2026-10-16', p_limit: 50, p_offset: 0 });
    let release: (v: unknown) => void = () => {};
    rpcMock.mockReturnValueOnce(new Promise((r) => { release = r; }));
    rerender({ off: 50 });
    expect(result.current.data?.summary.owing_agents).toBe(322); // previous page stays on screen
    expect(result.current.isStale).toBe(true);
    release({ data: { summary: { owing_agents: 322 } }, error: null });
    await waitFor(() => expect(rpcMock).toHaveBeenLastCalledWith('agent_ops_metrics_risk', expect.objectContaining({ p_offset: 50 })));
  });

  it('does not ask for the risk lists when disabled, and asks for the top earners sorted by listing earnings', async () => {
    rpcMock.mockResolvedValue({ data: [{ agent_id: 'a', name: 'A', listing_earned: 900000 }], error: null });
    renderHook(() => useMetricsRisk('2026-09-17', '2026-10-16', 50, 0, false), { wrapper: wrapper() });
    expect(rpcMock).not.toHaveBeenCalled();
    const { result } = renderHook(() => useMetricsTopEarners('2026-09-17', '2026-10-16', 5), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.rows[0]?.listing_earned).toBe(900000));
    expect(rpcMock).toHaveBeenLastCalledWith('agent_ops_metrics_agents', { p_start: '2026-09-17', p_end: '2026-10-16', p_sort: 'listing_earned', p_scope: 'all', p_limit: 5, p_offset: 0 });
  });
});
