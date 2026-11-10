import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMySignages, useSignageOpsQueue, useSignageDetail } from '@/hooks/useWelileSignages';

const mocks = vi.hoisted(() => ({ auth: { user: null as null | { id: string }, session: null as any, loading: true }, stored: null as any,
  select: vi.fn(), eq: vi.fn(), order: vi.fn(), detail: vi.fn(), from: vi.fn() }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/lib/sessionCache', () => ({ readStoredAuthSession: () => mocks.stored, isSessionPastMaxAge: () => false }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: mocks.from } }));

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
beforeEach(() => {
  cleanup(); vi.clearAllMocks(); localStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.auth = { user: null, session: null, loading: true };
  mocks.stored = { access_token: 'test', expires_at: Date.now() / 1000 + 3600, user: { id: 'agent-1' } };
  const chain = { select: mocks.select, eq: mocks.eq, abortSignal: () => chain, order: mocks.order, maybeSingle: mocks.detail };
  mocks.from.mockReturnValue(chain); mocks.select.mockReturnValue(chain); mocks.eq.mockReturnValue(chain);
  mocks.order.mockResolvedValue({ data: [{ id: 'signage-1', status: 'pending' }], error: null });
  mocks.detail.mockResolvedValue({ data: { id: 'signage-1', photos: [{ url: 'data:image/webp;base64,test' }] }, error: null });
});
describe('Signages queue loading', () => {
  it.each([useMySignages, useSignageOpsQueue])('starts a photo-free queue from a cached session while roles are loading', async (hook) => {
    const first = renderHook(hook, { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    const columns = mocks.select.mock.calls[0][0].split(',');
    expect(columns).toContain('status');
    expect(columns).not.toContain('photos');
    expect(columns).not.toContain('installation_photos');
    first.unmount();
    renderHook(hook, { wrapper });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });
  it('does not request evidence until an application is selected', async () => {
    const { rerender, result } = renderHook(({ id }: { id?: string }) => useSignageDetail(id), { initialProps: { id: undefined } as { id?: string }, wrapper });
    expect(mocks.from).not.toHaveBeenCalled();
    rerender({ id: 'signage-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.eq).toHaveBeenCalledWith('id', 'signage-1');
    expect(result.current.data?.photos).toHaveLength(1);
  });
  it('does not read protected queues without a session or with an expired cached session', async () => {
    mocks.stored = null;
    const { rerender } = renderHook(useSignageOpsQueue, { wrapper });
    mocks.stored = { access_token: 'test', expires_at: 1, user: { id: 'agent-1' } };
    rerender();
    await act(async () => { await Promise.resolve(); });
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('does not use a different cached account when the current user is known', () => {
    mocks.auth.user = { id: 'agent-2' };
    renderHook(useSignageOpsQueue, { wrapper });
    expect(mocks.from).not.toHaveBeenCalled();
  });
});