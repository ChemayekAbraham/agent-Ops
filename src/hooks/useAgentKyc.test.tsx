import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const state = vi.hoisted(() => ({ user: { id: 'reviewer-one' } as { id: string } | null, rpc: vi.fn() }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...args: unknown[]) => state.rpc(...args) } }));
vi.mock('@/hooks/useIdentityPhotos', () => ({ identityPhotoUrl: vi.fn() }));
import { useAgentKycOverview, useAgentKycIdentityGroup, useAgentKycIdentitySummary } from './useAgentVettingQueue';

function wrap(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
}
beforeEach(() => { state.user = { id: 'reviewer-one' }; state.rpc.mockReset(); });
describe('KYC read-only reporting', () => {
  it('requests the actual 7-day event report and forwards active scope', async () => {
    state.rpc.mockResolvedValue({ data: { series: [], counts: {} }, error: null });
    const { result } = renderHook(() => useAgentKycOverview(7, true), { wrapper: wrap() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(state.rpc).toHaveBeenCalledWith('agent_kyc_overview', { p_days: 7, p_in_scope_only: true });
  });
  it('requests 30 days without changing the agent scope', async () => {
    state.rpc.mockResolvedValue({ data: { series: [] }, error: null });
    renderHook(() => useAgentKycOverview(30, false), { wrapper: wrap() });
    await waitFor(() => expect(state.rpc).toHaveBeenCalledWith('agent_kyc_overview', { p_days: 30, p_in_scope_only: false }));
  });
  it('reads selected-agent membership in 50-row pages', async () => {
    state.rpc.mockResolvedValue({ data: { total: 70, linked_count: 69, masked_nin: 'CM0*******1234', members: [] }, error: null });
    const { result } = renderHook(() => useAgentKycIdentityGroup('selected-agent', 1), { wrapper: wrap() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(state.rpc).toHaveBeenCalledWith('agent_kyc_identity_group', { p_agent_id: 'selected-agent', p_limit: 50, p_offset: 50 });
    expect(result.current.data?.masked_nin).toBe('CM0*******1234');
  });
  it('does not query a signed-out user', () => {
    state.user = null;
    renderHook(() => useAgentKycOverview(7, false), { wrapper: wrap() });
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it('does not fetch identity summaries for an empty queue', () => {
    renderHook(() => useAgentKycIdentitySummary([]), { wrapper: wrap() });
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it('does not retry a terminal authorization failure', async () => {
    state.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'Not authorized' } });
    const { result } = renderHook(() => useAgentKycOverview(7, false), { wrapper: wrap() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(state.rpc).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBeUndefined();
  });
  it('does not reuse identity-group data across reviewer accounts', async () => {
    state.rpc.mockResolvedValue({ data: { total: 1, members: [] }, error: null });
    const client = new QueryClient();
    const { result, rerender } = renderHook(() => useAgentKycIdentityGroup('selected-agent', 0), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    state.user = { id: 'reviewer-two' };
    rerender();
    await waitFor(() => expect(state.rpc).toHaveBeenCalledTimes(2));
  });
});