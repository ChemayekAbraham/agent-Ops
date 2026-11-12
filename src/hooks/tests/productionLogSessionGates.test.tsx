import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useFunderFloatAvailable } from '@/components/funder-preview/useFunderPreviewSupport';
import { useAgentCapacityMap } from '@/hooks/useAgentCapacityMap';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), getSession: vi.fn(), ready: false }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'partner-1' } }) }));
vi.mock('@/hooks/useAuthenticatedPoll', async (original) => {
  const actual = await original<typeof import('@/hooks/useAuthenticatedPoll')>();
  return { ...actual, useAuthenticatedAudience: () => mocks.ready };
});
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  rpc: mocks.rpc, auth: { getSession: mocks.getSession },
  channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel: vi.fn(),
} }));
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}
beforeEach(() => { vi.clearAllMocks(); mocks.ready = false; mocks.getSession.mockResolvedValue({ data: { session: null }, error: null }); });
describe('production permission errors', () => {
  it('does not start weekly eligibility while signed out', () => {
    const { result } = renderHook(() => useAgentCapacityMap(['agent-1']), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('stops a stale signed-in weekly query before any RPC if the live session disappeared', async () => {
    mocks.ready = true;
    const { result } = renderHook(() => useAgentCapacityMap(['agent-1']), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('reads the ownership-checked wrapper and its authoritative float amount', async () => {
    mocks.ready = true;
    mocks.getSession.mockResolvedValue({ data: { session: { user: { id: 'partner-1' }, access_token: 'test-user' } }, error: null });
    mocks.rpc.mockResolvedValue({ data: 123456, error: null });
    const { result } = renderHook(() => useFunderFloatAvailable('partner-1'), { wrapper });
    await waitFor(() => expect(result.current.data).toBe(123456));
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('funder_support_capacity', { p_user_id: 'partner-1' });
  });
  it('does not query another user’s float from the own-balance hook', () => {
    mocks.ready = true;
    const { result } = renderHook(() => useFunderFloatAvailable('other-partner'), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});