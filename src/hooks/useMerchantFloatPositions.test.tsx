import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { stopMerchantFloatPositionsPoll } from '@/hooks/merchantFloatPositionsAccess';

const rpc = vi.fn();
const getSession = vi.fn();
const auth = {
  user: { id: 'user-1' } as { id: string } | null,
  session: { access_token: 'jwt' } as { access_token?: string } | null,
  loading: false,
  rolesResolved: true,
  roles: ['agent'] as string[],
};

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => auth,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    auth: { getSession: () => getSession() },
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: () => {},
  },
}));

import { useMerchantFloatPositions } from '@/hooks/useMerchantFloat';

const FINANCE_ROLES = ['cfo', 'financial_ops', 'manager', 'super_admin', 'ceo', 'coo'] as const;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function positionCalls() {
  return rpc.mock.calls.filter(([name]) => name === 'get_merchant_float_positions');
}

describe('stopMerchantFloatPositionsPoll', () => {
  it('stops on the live RAISE and on a dead session, and keeps going after a timeout', () => {
    expect(stopMerchantFloatPositionsPoll({ code: 'P0001', message: 'Not authorized' })).toBe(true);
    expect(stopMerchantFloatPositionsPoll({ code: '42501', message: 'Not authorized' })).toBe(true);
    expect(stopMerchantFloatPositionsPoll(new Error('Not authorised'))).toBe(true);
    expect(stopMerchantFloatPositionsPoll({ status: 401, message: 'JWT expired' })).toBe(true);
    expect(stopMerchantFloatPositionsPoll({
      code: '57014',
      message: 'canceling statement due to statement timeout',
    })).toBe(false);
    expect(stopMerchantFloatPositionsPoll(null)).toBe(false);
  });
});

describe('useMerchantFloatPositions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rpc.mockReset();
    getSession.mockReset();
    auth.user = { id: 'user-1' };
    auth.session = { access_token: 'jwt' };
    auth.loading = false;
    auth.rolesResolved = true;
    auth.roles = ['agent'];
    getSession.mockResolvedValue({
      data: { session: { access_token: 'jwt', expires_at: 9_999_999_999 } },
      error: null,
    });
    rpc.mockResolvedValue({ data: [], error: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['agent', 'tenant', 'employee', 'operations', 'landlord'] as const)(
    'does not call get_merchant_float_positions for a signed-in %s',
    async (role) => {
      auth.roles = [role];
      const { result } = renderHook(() => useMerchantFloatPositions(), { wrapper });
      await act(async () => { await vi.advanceTimersByTimeAsync(150_000); });
      expect(positionCalls()).toHaveLength(0);
      expect(getSession).not.toHaveBeenCalled();
      expect(result.current.isError).toBe(true);
      expect((result.current.error as Error).message).toBe('Not authorized');
    },
  );

  it.each(FINANCE_ROLES)('calls the RPC for a signed-in %s', async (role) => {
    auth.roles = [role];
    const { result } = renderHook(() => useMerchantFloatPositions(), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(positionCalls()).toHaveLength(1);
    expect(positionCalls()[0]?.[1]).toBeUndefined();
    expect(result.current.isSuccess).toBe(true);
  });

  it('does not call while the role list is still loading', async () => {
    auth.loading = true;
    auth.rolesResolved = false;
    auth.roles = ['cfo'];
    renderHook(() => useMerchantFloatPositions(), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(positionCalls()).toHaveLength(0);
  });

  it('does not call when the hook is turned off, even for a finance role', async () => {
    auth.roles = ['cfo'];
    renderHook(() => useMerchantFloatPositions(false), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(positionCalls()).toHaveLength(0);
  });

  it('stops the poll when the server raises Not authorized', async () => {
    auth.roles = ['cfo'];
    rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'Not authorized' } });
    const { result } = renderHook(() => useMerchantFloatPositions(), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.isError).toBe(true);
    expect(positionCalls()).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(150_000); });
    expect(positionCalls()).toHaveLength(1);
  });

  it('keeps polling after a timeout', async () => {
    auth.roles = ['manager'];
    rpc.mockResolvedValue({
      data: null,
      error: { code: '57014', message: 'canceling statement due to statement timeout' },
    });
    renderHook(() => useMerchantFloatPositions(), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(positionCalls()).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(positionCalls().length).toBeGreaterThan(1);
  });

  it('does not call when the access token is already dead', async () => {
    auth.roles = ['coo'];
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    const { result } = renderHook(() => useMerchantFloatPositions(), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(positionCalls()).toHaveLength(0);
    expect(result.current.isError).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(150_000); });
    expect(positionCalls()).toHaveLength(0);
  });
});
