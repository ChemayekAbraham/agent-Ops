import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCfoApproveSignage, useCfoDisburseSignage } from '@/hooks/useWelileSignages';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('@/lib/authenticatedRequests', () => ({ withUserSession: (load: () => unknown) => load() }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'cfo' } }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>{children}</QueryClientProvider>;
}

beforeEach(() => { cleanup(); vi.clearAllMocks(); });
describe('CFO approval separate from signage payments', () => {
  it('activates using approval only and never calls the payment function', async () => {
    mocks.rpc.mockResolvedValue({ data: { signage_id: 'signage', status: 'active' }, error: null });
    const { result } = renderHook(() => useCfoApproveSignage(), { wrapper });
    await act(async () => { await result.current.mutateAsync('signage'); });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('cfo_approve_signage', { p_signage_id: 'signage' });
  });
  it('does not pretend approval succeeded when activation is not confirmed', async () => {
    mocks.rpc.mockResolvedValue({ data: { signage_id: 'signage', status: 'awaiting_cfo' }, error: null });
    const { result } = renderHook(() => useCfoApproveSignage(), { wrapper });
    await act(async () => { await expect(result.current.mutateAsync('signage')).rejects.toThrow('could not be confirmed'); });
  });
  it('keeps the one-time UGX 3,000 agent reward available independently of owner payments', async () => {
    mocks.rpc.mockResolvedValue({ data: { signage_id: 'signage', status: 'awaiting_cfo', amount_ugx: 3000, ledger_group_id: 'group' }, error: null });
    const { result } = renderHook(() => useCfoDisburseSignage(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ signageId: 'signage', payoutType: 'agent_reward', amountUgx: 3000, periodIndex: 0 }); });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('cfo_disburse_signage', {
      p_signage_id: 'signage', p_payout_type: 'agent_reward', p_period_index: 0,
    });
  });
  it('keeps the server refusal when owner payout is attempted in the first 30 days', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'Owner monthly payout is available only for an active signage at least 30 days after submission' } });
    const { result } = renderHook(() => useCfoDisburseSignage(), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ signageId: 'signage', payoutType: 'owner_rent', amountUgx: 10000, periodIndex: 0 })).rejects.toThrow('30 days');
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});