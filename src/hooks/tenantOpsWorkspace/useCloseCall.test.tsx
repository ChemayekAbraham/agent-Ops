/**
 * useCloseCall is the "promise resolver": given a call outcome, it decides
 * (a) which existing cc_ RPC closes the underlying call-engine attempt the
 * same way the engine's own UI would, and (b) whether to also insert a row
 * into tops_promises_to_pay. Only outcome === 'promised' with a `promise`
 * payload may insert one; every other outcome must not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCloseCall } from './useCloseCall';
import { supabase } from '@/integrations/supabase/client';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: { getUser: vi.fn() },
    rpc: vi.fn(),
    from: vi.fn(),
  },
}));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const BASE_INPUT = {
  attemptId: 'attempt-1',
  rentRequestId: 'rr-1',
  tenantUserId: 'tenant-1',
  note: 'called, discussed balance',
};

describe('useCloseCall — the promise resolver', () => {
  let insertMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    (supabase.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { user: { id: 'officer-1' } } });
    (supabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ error: null });
    insertMock = vi.fn().mockResolvedValue({ error: null });
    (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ insert: insertMock });
  });

  it('routes outcome "promised" through cc_record_engaged and inserts a tops_promises_to_pay row', async () => {
    const { result } = renderHook(() => useCloseCall(), { wrapper });

    await result.current.mutateAsync({
      ...BASE_INPUT,
      outcome: 'promised',
      promise: { promisedAmountUgx: 40_000, promisedDate: '2026-02-01', channel: 'call' },
    });

    expect(supabase.rpc).toHaveBeenCalledWith('cc_record_engaged', expect.objectContaining({ p_attempt_id: 'attempt-1' }));
    expect(supabase.from).toHaveBeenCalledWith('tops_promises_to_pay');
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rent_request_id: 'rr-1',
        tenant_user_id: 'tenant-1',
        promised_amount_ugx: 40_000,
        promised_date: '2026-02-01',
        channel: 'call',
        taken_by: 'officer-1',
      }),
    );
  });

  it('does not insert a promise row for a "reached" outcome with no promise payload', async () => {
    const { result } = renderHook(() => useCloseCall(), { wrapper });

    await result.current.mutateAsync({ ...BASE_INPUT, outcome: 'reached' });

    expect(supabase.from).not.toHaveBeenCalledWith('tops_promises_to_pay');
  });

  it.each([
    ['refused', 'cc_record_unreached', { p_outcome: 'refused' }],
    ['unreachable', 'cc_record_unreached', { p_outcome: 'no_answer' }],
    ['wrong_number', 'cc_record_unreached', { p_outcome: 'wrong_number' }],
  ] as const)('routes outcome "%s" through %s with %o', async (outcome, expectedRpc, expectedArgs) => {
    const { result } = renderHook(() => useCloseCall(), { wrapper });

    await result.current.mutateAsync({ ...BASE_INPUT, outcome });

    expect(supabase.rpc).toHaveBeenCalledWith(expectedRpc, expect.objectContaining(expectedArgs));
    expect(supabase.from).not.toHaveBeenCalledWith('tops_promises_to_pay');
  });

  it('routes "disputes_balance" through cc_record_engaged with the payment-dispute category, never a promise', async () => {
    const { result } = renderHook(() => useCloseCall(), { wrapper });

    await result.current.mutateAsync({ ...BASE_INPUT, outcome: 'disputes_balance' });

    expect(supabase.rpc).toHaveBeenCalledWith(
      'cc_record_engaged',
      expect.objectContaining({ p_category_id: '2850c003-8ae1-4b37-ac21-3098b49e8082' }),
    );
    expect(supabase.from).not.toHaveBeenCalledWith('tops_promises_to_pay');
  });

  it('always records our own tops_call_outcomes row regardless of which cc_ path was taken', async () => {
    const { result } = renderHook(() => useCloseCall(), { wrapper });

    await result.current.mutateAsync({ ...BASE_INPUT, outcome: 'refused' });

    expect(supabase.from).toHaveBeenCalledWith('tops_call_outcomes');
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ cc_call_id: 'attempt-1', outcome: 'refused', recorded_by: 'officer-1' }),
    );
  });

  it('rejects when no session user is present, before touching any RPC', async () => {
    (supabase.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { user: null } });
    const { result } = renderHook(() => useCloseCall(), { wrapper });

    await expect(result.current.mutateAsync({ ...BASE_INPUT, outcome: 'reached' })).rejects.toThrow('Not signed in');
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});
