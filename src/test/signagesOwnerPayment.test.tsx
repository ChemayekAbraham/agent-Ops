import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCfoDisburseSignage, useCfoTerminateSignage, useCfoDeclineInstallation } from '@/hooks/useWelileSignages';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('@/lib/authenticatedRequests', () => ({ withUserSession: (load: () => unknown) => load() }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'cfo' } }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>{children}</QueryClientProvider>;
}

beforeEach(() => { cleanup(); vi.clearAllMocks(); });
describe('CFO signage actions', () => {
  it('terminates a contract with a reason and makes no payment', async () => {
    mocks.rpc.mockResolvedValue({ data: { signage_id: 'signage', status: 'removed' }, error: null });
    const { result } = renderHook(() => useCfoTerminateSignage(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ signageId: 'signage', reason: 'Owner ended the contract' }); });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('cfo_terminate_signage', { p_signage_id: 'signage', p_reason: 'Owner ended the contract' });
  });
  it('refuses to decline an installation without a real reason', async () => {
    const { result } = renderHook(() => useCfoDeclineInstallation(), { wrapper });
    await act(async () => { await expect(result.current.mutateAsync({ signageId: 'signage', reason: 'blurry' })).rejects.toThrow('10 characters'); });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('pays the one-time UGX 3,000 agent reward, which activates the signage', async () => {
    mocks.rpc.mockResolvedValue({ data: { signage_id: 'signage', status: 'active', amount_ugx: 3000, ledger_group_id: 'group' }, error: null });
    const { result } = renderHook(() => useCfoDisburseSignage(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ signageId: 'signage', payoutType: 'agent_reward', amountUgx: 3000, periodIndex: 0 }); });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('cfo_disburse_signage', {
      p_signage_id: 'signage', p_payout_type: 'agent_reward', p_period_index: 0,
    });
  });
  it('keeps the server refusal when owner payout is attempted in the first month', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "The owner's next payout is due on 13 Dec 2026. The first month after activation is not paid." } });
    const { result } = renderHook(() => useCfoDisburseSignage(), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ signageId: 'signage', payoutType: 'owner_rent', amountUgx: 10000, periodIndex: 0 })).rejects.toThrow('first month');
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});