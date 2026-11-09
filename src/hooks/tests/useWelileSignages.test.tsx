import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useReviewSignage } from '@/hooks/useWelileSignages';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), update: vi.fn(), result: vi.fn() }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'agent' }, loading: false }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  rpc: mocks.rpc,
  from: () => ({ update: mocks.update }),
} }));

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>{children}</QueryClientProvider>;
}

describe('Signages approval requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockReturnValue({ eq: () => ({ select: mocks.result }) });
    mocks.result.mockResolvedValue({ data: [{ id: 'signage' }], error: null });
  });
  it('sends Agent Ops approval to Awaiting COO', async () => {
    const { result } = renderHook(() => useReviewSignage(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ signageId: 'signage', decision: 'approve' }); });
    expect(mocks.update).toHaveBeenCalledWith({ status: 'awaiting_coo', review_notes: null, rejection_reason: null });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('uses the COO decision RPC before authorizing installation', async () => {
    mocks.rpc.mockResolvedValue({ data: { id: 'signage', status: 'approved_for_installation' }, error: null });
    const { result } = renderHook(() => useReviewSignage('coo'), { wrapper });
    await act(async () => { await result.current.mutateAsync({ signageId: 'signage', decision: 'approve', notes: 'Location checked' }); });
    expect(mocks.rpc).toHaveBeenCalledWith('coo_decide_signage', { p_signage_id: 'signage', p_decision: 'approve', p_notes: 'Location checked' });
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('does not report success if the server refuses a stale COO decision', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'No longer awaiting COO' } });
    const { result } = renderHook(() => useReviewSignage('coo'), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ signageId: 'signage', decision: 'approve' })).rejects.toThrow('No longer awaiting COO');
    });
  });
});