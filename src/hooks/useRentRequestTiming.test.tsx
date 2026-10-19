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

import { useRentRequestTiming, useRentRequestTimingHistory } from './useRentRequestTiming';

const wrapper = (qc: QueryClient) => ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const row = (id: string) => ({ request_id: id, state: 'at_desk', desk: 'agent_ops', current: { desk: 'agent_ops', entry: '2026-10-18T12:00:00Z', seconds: 86400, quality: 'confirmed' }, total_seconds: 86400, quality: 'confirmed' });
beforeEach(() => rpcMock.mockReset());

describe('useRentRequestTiming', () => {
  it('asks once for the whole desk (never one call per card) and indexes the rows by request id', async () => {
    rpcMock.mockResolvedValue({ data: { as_of: '2026-10-19T12:00:00Z', requested: 3, returned: 2, rows: [row('a'), row('b')] }, error: null });
    const { result } = renderHook(() => useRentRequestTiming(['a', 'b', 'c', 'a']), { wrapper: wrapper(client()) });
    await waitFor(() => expect(result.current.batch).not.toBeNull());
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('rent_request_timing', { p_request_ids: ['a', 'b', 'c'] });
    expect(result.current.asOf).toBe('2026-10-19T12:00:00Z');
    expect(result.current.byId.get('a')?.current?.seconds).toBe(86400);
    expect(result.current.byId.get('c')).toBeUndefined();   // not visible: no row, the card says Not available
    expect(result.current.omitted).toBe(0);
  });

  it('does nothing for an empty desk or when disabled', async () => {
    renderHook(() => useRentRequestTiming([]), { wrapper: wrapper(client()) });
    renderHook(() => useRentRequestTiming(['a'], { enabled: false }), { wrapper: wrapper(client()) });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('sends at most 200 ids and says how many were left out instead of losing them silently', async () => {
    rpcMock.mockResolvedValue({ data: { as_of: '2026-10-19T12:00:00Z', rows: [] }, error: null });
    const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`);
    const { result } = renderHook(() => useRentRequestTiming(ids), { wrapper: wrapper(client()) });
    await waitFor(() => expect(result.current.batch).not.toBeNull());
    expect((rpcMock.mock.calls[0][1] as { p_request_ids: string[] }).p_request_ids).toHaveLength(200);
    expect(result.current.omitted).toBe(250);
  });

  it('a failure is an error, never a zero: no batch, no rows, the error is returned and can be retried', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'boom', code: '42501' } }).mockResolvedValueOnce({ data: { as_of: 'x', rows: [row('a')] }, error: null });
    const { result } = renderHook(() => useRentRequestTiming(['a']), { wrapper: wrapper(client()) });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.batch).toBeNull();
    expect(result.current.byId.size).toBe(0);
    result.current.refetch();
    await waitFor(() => expect(result.current.byId.get('a')).toBeDefined());
  });

  it('does not poll: no refetch interval and the same ids in another order reuse the cached answer', async () => {
    rpcMock.mockResolvedValue({ data: { as_of: 'x', rows: [row('a')] }, error: null });
    const qc = client();
    const { result } = renderHook(({ ids }) => useRentRequestTiming(ids), { wrapper: wrapper(qc), initialProps: { ids: ['a', 'b'] } });
    await waitFor(() => expect(result.current.batch).not.toBeNull());
    renderHook(() => useRentRequestTiming(['b', 'a']), { wrapper: wrapper(qc) });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    const q = qc.getQueryCache().findAll({ queryKey: ['rent-request-timing'] })[0];
    expect((q.options as { refetchInterval?: unknown }).refetchInterval).toBeUndefined();
  });
});

describe('useRentRequestTimingHistory', () => {
  it('loads the deep history only when asked for, for one request', async () => {
    rpcMock.mockResolvedValue({ data: { request_id: 'a', state: 'at_desk', visits: [{ desk: 'agent_ops', start: '2026-10-01T00:00:00Z', end: '2026-10-04T00:00:00Z', seconds: 259200, quality: 'confirmed' }], as_of: '2026-10-19T12:00:00Z' }, error: null });
    const qc = client();
    const { result, rerender } = renderHook(({ on }: { on: boolean }) => useRentRequestTimingHistory('a', on), { wrapper: wrapper(qc), initialProps: { on: false } });
    expect(rpcMock).not.toHaveBeenCalled();
    rerender({ on: true });
    await waitFor(() => expect(result.current.data?.visits?.length).toBe(1));
    expect(rpcMock).toHaveBeenCalledWith('rent_request_timing_history', { p_request_id: 'a' });
    expect(result.current.data?.visits?.[0].seconds).toBe(259200);
  });

  it('a history failure is an error, not an empty journey', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'nope' } });
    const { result } = renderHook(() => useRentRequestTimingHistory('a', true), { wrapper: wrapper(client()) });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.data).toBeNull();
  });
});
