import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) } }));

import { useAwarenessCallStatus } from './useAwarenessCallStatus';

const row = (id: string) => ({ rent_request_id: id, calls_total: 0, calls_at_current_stage: 0, answered_at_current_stage: 0, last_call_at: null, answered_person_types: [] });
const make = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return wrapper;
};
const calls = () => rpcMock.mock.calls.filter((c) => c[0] === 'awareness_call_status_for_requests').map((c) => c[1].p_request_ids as string[]);

describe('useAwarenessCallStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpcMock.mockImplementation((_fn: string, args: { p_request_ids: string[] }) => Promise.resolve({ data: args.p_request_ids.map(row), error: null }));
  });

  it('reads a whole list in ONE call, not one per card, with each id once', async () => {
    const ids = ['c', 'a', 'b', 'a'];
    const { result } = renderHook(() => useAwarenessCallStatus(ids), { wrapper: make() });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(calls()).toEqual([['a', 'b', 'c']]);
    expect(result.current.byId.get('b')?.rent_request_id).toBe('b');
  });

  it('reads more than 200 Rent Plans in chunks of at most 200 (one call each)', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id-${String(i).padStart(3, '0')}`);
    const { result } = renderHook(() => useAwarenessCallStatus(ids), { wrapper: make() });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(calls().map((c) => c.length)).toEqual([200, 200, 50]);
    expect(result.current.byId.size).toBe(450);
  });

  it('does not read again for the same list, even in a different order', async () => {
    const wrapper = make();
    const first = renderHook(() => useAwarenessCallStatus(['a', 'b']), { wrapper });
    await waitFor(() => expect(first.result.current.loaded).toBe(true));
    const second = renderHook(() => useAwarenessCallStatus(['b', 'a']), { wrapper });
    await waitFor(() => expect(second.result.current.loaded).toBe(true));
    expect(calls()).toHaveLength(1);
  });

  it('reads nothing for an empty list', () => {
    renderHook(() => useAwarenessCallStatus([]), { wrapper: make() });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('on failure there are no statuses and nothing throws', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'not authorized' } });
    const { result } = renderHook(() => useAwarenessCallStatus(['a']), { wrapper: make() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.loaded).toBe(false);
    expect(result.current.byId.size).toBe(0);
  });

  it('can be switched off', () => {
    renderHook(() => useAwarenessCallStatus(['a'], false), { wrapper: make() });
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
