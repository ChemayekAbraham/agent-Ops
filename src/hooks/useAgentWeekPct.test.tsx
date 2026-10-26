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

import { useAgentWeekPct } from './useAgentWeekPct';

const wrapper = (qc: QueryClient) => ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const week = (agent: string) => ({
  agent_id: agent, week_start: '2026-10-22', week_end: '2026-10-28', days_left: 2, book: 'in_window_only',
  in_window_plans: 2, in_window_collected: 50, in_window_due_so_far: 80, in_window_projected_due: 100, in_window_required_pct: 0.5,
  expired_plans: 0, expired_collected: 0, expired_due_so_far: 0, expired_projected_due: 0, expired_required_pct: null,
});
beforeEach(() => { rpcMock.mockReset(); });

describe('useAgentWeekPct', () => {
  it('asks once for the whole desk (never one call per card) and indexes the rows by agent id', async () => {
    rpcMock.mockResolvedValue({ data: [week('a1'), week('a2')], error: null });
    const { result } = renderHook(() => useAgentWeekPct(['r2', 'r1', 'r2']), { wrapper: wrapper(client()) });
    await waitFor(() => expect(result.current.byAgent.size).toBe(2));
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('rent_request_agent_week_pct', { p_request_ids: ['r1', 'r2'] });
    expect(result.current.byAgent.get('a1')?.in_window_collected).toBe(50);
  });

  it('sends a very large desk in batches of 2000 requests and joins the answers', async () => {
    const ids = Array.from({ length: 4500 }, (_, i) => `r${String(i).padStart(5, '0')}`);
    rpcMock.mockImplementation(async (_name: string, args: { p_request_ids: string[] }) => ({ data: [week(`a-${args.p_request_ids[0]}`)], error: null }));
    const { result } = renderHook(() => useAgentWeekPct(ids), { wrapper: wrapper(client()) });
    await waitFor(() => expect(result.current.byAgent.size).toBe(3));
    expect(rpcMock).toHaveBeenCalledTimes(3);
    expect(rpcMock.mock.calls.map((c) => (c[1] as { p_request_ids: string[] }).p_request_ids.length)).toEqual([2000, 2000, 500]);
  });

  it('does nothing for an empty desk or when disabled', async () => {
    renderHook(() => useAgentWeekPct([]), { wrapper: wrapper(client()) });
    renderHook(() => useAgentWeekPct(['r1'], { enabled: false }), { wrapper: wrapper(client()) });
    await new Promise((r) => setTimeout(r, 30));
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('reports an error and gives no percentages, so the cards show none and keep their order', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'Not authorized' } });
    const { result } = renderHook(() => useAgentWeekPct(['r1']), { wrapper: wrapper(client()) });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.byAgent.size).toBe(0);
  });
});
