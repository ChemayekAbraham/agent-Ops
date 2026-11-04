import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createElement } from 'react';

const rpc = vi.fn();
const auth = {
  user: { id: 'user-1' } as { id: string } | null,
  session: { access_token: 'jwt' } as { access_token?: string } | null,
  loading: false,
  rolesResolved: true,
  roles: ['agent'] as string[],
  enabledRoles: ['tenant'] as string[],
};

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

import { useMyAwarenessLog, useMyAwarenessSummary } from '@/hooks/useMyAwarenessCalls';

function calls(name: string) {
  return rpc.mock.calls.filter(([fn]) => fn === name);
}

function renderReads(client: QueryClient) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return renderHook(() => {
    useMyAwarenessSummary('2026-10-20', '2026-10-27');
    useMyAwarenessLog('2026-10-20', '2026-10-27', 5);
  }, { wrapper });
}

describe('useMyAwarenessCalls role gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rpc.mockReset();
    auth.user = { id: 'user-1' };
    auth.session = { access_token: 'jwt' };
    auth.loading = false;
    auth.rolesResolved = true;
    auth.roles = ['agent'];
    auth.enabledRoles = ['tenant'];
    rpc.mockImplementation((fn: string) => {
      if (fn === 'my_awareness_calls_summary') {
        return Promise.resolve({ data: null, error: { code: 'P0001', status: 400, message: 'not authorized' } });
      }
      if (fn === 'my_awareness_calls_log') {
        return Promise.resolve({ data: null, error: { code: 'P0001', status: 400, message: 'not authorized' } });
      }
      return Promise.resolve({ data: null, error: null });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tries once for a non-staff user and does not retry, poll, or refetch', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: 3, retryDelay: 0, gcTime: Infinity } },
    });
    const first = renderReads(client);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(calls('my_awareness_calls_summary')).toHaveLength(1);
    expect(calls('my_awareness_calls_log')).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    window.dispatchEvent(new Event('focus'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(calls('my_awareness_calls_summary')).toHaveLength(1);
    expect(calls('my_awareness_calls_log')).toHaveLength(1);

    first.unmount();
    renderReads(client);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(calls('my_awareness_calls_summary')).toHaveLength(1);
    expect(calls('my_awareness_calls_log')).toHaveLength(1);
  });

  it('still reads once for a service-centre manager who has no staff role', async () => {
    rpc.mockImplementation((fn: string) => {
      if (fn === 'my_awareness_calls_summary') {
        return Promise.resolve({ data: { totals: { calls: 1 } }, error: null });
      }
      if (fn === 'my_awareness_calls_log') {
        return Promise.resolve({ data: { total: 0, limit: 5, offset: 0, rows: [] }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: 3, gcTime: Infinity } } });
    const { result } = renderHook(() => useMyAwarenessSummary('2026-10-20', '2026-10-27'), {
      wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(calls('my_awareness_calls_summary')).toHaveLength(1);
    expect(result.current.data?.totals.calls).toBe(1);
  });

  it('does not call before the real enabled-role list is known', async () => {
    auth.loading = true;
    auth.rolesResolved = false;
    auth.enabledRoles = ['tenant_ops'];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderReads(client);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(calls('my_awareness_calls_summary')).toHaveLength(0);
    expect(calls('my_awareness_calls_log')).toHaveLength(0);
  });

  it('calls for a real enabled staff role and ignores a synthetic agent', async () => {
    auth.roles = ['agent', 'cto'];
    auth.enabledRoles = ['cto'];
    rpc.mockResolvedValue({ data: { totals: { calls: 2 }, total: 0, rows: [] }, error: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderReads(client);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(calls('my_awareness_calls_summary')).toHaveLength(1);
    expect(calls('my_awareness_calls_log')).toHaveLength(1);
  });
});
