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

import { useAgentOpsNetworkOverview } from './useAgentOpsNetworkOverview';

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapperFor = (qc: QueryClient) => ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

const payload = {
  range: { start: '2026-10-01', end: '2026-10-15', min_expected: 50000 },
  counts: { agents: 770, with_service_centres: 53, with_bikes: 2, with_smartphone_plan: 34, with_smartphone_tenants: 240, with_subagents: 166, posted_requests: 254, approved_agents: 124 },
  approved: { agents: 73, requests: 348, amount: 197940001, receivables_outstanding: 232937315 },
  top_portfolios: [{ agent_id: 'a-1', name: 'IAN MUHWEZI', phone: '+256787725122', portfolio: 49482312, plans: 19 }],
  top_collection_rate: [], default_rate_ascending: [],
};

beforeEach(() => { rpcMock.mockReset(); });

describe('useAgentOpsNetworkOverview', () => {
  it('calls get_agent_ops_network_overview with the two Kampala days and returns the typed answer', async () => {
    rpcMock.mockResolvedValue({ data: payload, error: null });
    const { result } = renderHook(() => useAgentOpsNetworkOverview('2026-10-01', '2026-10-15'), { wrapper: wrapperFor(client()) });
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(rpcMock).toHaveBeenCalledWith('get_agent_ops_network_overview', { p_start: '2026-10-01', p_end: '2026-10-15' });
    expect(result.current.data?.counts.agents).toBe(770);
    expect(result.current.data?.approved.amount).toBe(197940001);
    expect(result.current.data?.top_portfolios[0]).toMatchObject({ agent_id: 'a-1', portfolio: 49482312 });
    expect(result.current.error).toBeNull();
  });

  it('renders a zero payload as zeros and empty lists', async () => {
    rpcMock.mockResolvedValue({ data: { counts: {}, approved: {}, top_portfolios: [], top_collection_rate: [], default_rate_ascending: [] }, error: null });
    const { result } = renderHook(() => useAgentOpsNetworkOverview('2026-10-01', '2026-10-15'), { wrapper: wrapperFor(client()) });
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data?.counts.agents).toBe(0);
    expect(result.current.data?.top_portfolios).toEqual([]);
  });

  it('keys the cache by start and end: a new range asks again, the same range does not', async () => {
    rpcMock.mockResolvedValue({ data: payload, error: null });
    const qc = client();
    const { result, rerender } = renderHook((p: { s: string; e: string }) => useAgentOpsNetworkOverview(p.s, p.e), { wrapper: wrapperFor(qc), initialProps: { s: '2026-10-01', e: '2026-10-15' } });
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(rpcMock).toHaveBeenCalledTimes(1);
    rerender({ s: '2026-10-10', e: '2026-10-15' });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('get_agent_ops_network_overview', { p_start: '2026-10-10', p_end: '2026-10-15' }));
    expect(rpcMock).toHaveBeenCalledTimes(2);
    rerender({ s: '2026-10-01', e: '2026-10-15' });
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(rpcMock).toHaveBeenCalledTimes(2); // fresh for 60 seconds, so the first range is served from the cache
  });

  it('is fresh for 60 seconds', async () => {
    rpcMock.mockResolvedValue({ data: payload, error: null });
    const qc = client();
    const { result } = renderHook(() => useAgentOpsNetworkOverview('2026-10-01', '2026-10-15'), { wrapper: wrapperFor(qc) });
    await waitFor(() => expect(result.current.data).not.toBeNull());
    const q = qc.getQueryCache().find({ queryKey: ['agent-ops-network-overview', '2026-10-01', '2026-10-15'] });
    expect((q?.options as { staleTime?: number }).staleTime).toBe(60_000);
  });

  it('does nothing until it has both days (or while disabled)', () => {
    const { result } = renderHook(() => useAgentOpsNetworkOverview('', '2026-10-15'), { wrapper: wrapperFor(client()) });
    expect(result.current.data).toBeNull();
    expect(rpcMock).not.toHaveBeenCalled();
    renderHook(() => useAgentOpsNetworkOverview('2026-10-01', '2026-10-15', false), { wrapper: wrapperFor(client()) });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('surfaces the server error and refetch asks again', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: '42501', message: 'not_authorized' } });
    const { result } = renderHook(() => useAgentOpsNetworkOverview('2026-10-01', '2026-10-15'), { wrapper: wrapperFor(client()) });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.data).toBeNull();
    rpcMock.mockResolvedValue({ data: payload, error: null });
    result.current.refetch();
    await waitFor(() => expect(result.current.data?.counts.agents).toBe(770));
  });

  it('only ever calls the one read function', async () => {
    rpcMock.mockResolvedValue({ data: payload, error: null });
    const { result } = renderHook(() => useAgentOpsNetworkOverview('2026-10-01', '2026-10-15'), { wrapper: wrapperFor(client()) });
    await waitFor(() => expect(result.current.data).not.toBeNull());
    for (const [fn] of rpcMock.mock.calls) expect(fn).toBe('get_agent_ops_network_overview');
  });
});
