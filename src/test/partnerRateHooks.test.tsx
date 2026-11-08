/**
 * usePartnerQuoteRate / useOwnNewPortfolioRate / useStaffPortfolioRate (design v2 §6.1): a person's
 * own rate comes from partner_quote_rate, null means no number, and a staff form sends a rate only
 * as the contract says.
 */
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), user: null as null | { id: string } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mocks.user }) }));

import { useOwnNewPortfolioRate, usePartnerQuoteRate } from '@/hooks/usePartnerQuoteRate';
import { useStaffPortfolioRate } from '@/hooks/useStaffPortfolioRate';

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const policy = (enabled: boolean) => ({ data: { enabled, new_contract_rate: enabled ? 10 : 15 }, error: null });

beforeEach(() => {
  localStorage.clear();
  mocks.rpc.mockReset();
  mocks.user = { id: 'staff-1' };
});

describe('usePartnerQuoteRate', () => {
  it("reads the signed-in caller's own rate", async () => {
    mocks.rpc.mockResolvedValue({ data: 20, error: null });
    const { result } = renderHook(() => useOwnNewPortfolioRate(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.rate).toBe(20));
    expect(mocks.rpc).toHaveBeenCalledWith('partner_quote_rate', { p_quote_for: 'me', p_partner_id: null });
  });

  it('null and no call when signed out', () => {
    mocks.user = null;
    const { result } = renderHook(() => useOwnNewPortfolioRate(), { wrapper: wrapper() });
    expect(result.current).toEqual({ rate: null, isLoading: false });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("'partner' needs an id; an error answers null (never the public rate)", async () => {
    const none = renderHook(() => usePartnerQuoteRate('partner', null), { wrapper: wrapper() });
    expect(none.result.current.rate).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled();

    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'NOT_AUTHORIZED' } });
    const denied = renderHook(() => usePartnerQuoteRate('partner', 'p1'), { wrapper: wrapper() });
    await waitFor(() => expect(denied.result.current.isLoading).toBe(false));
    expect(denied.result.current.rate).toBeNull();
    expect(mocks.rpc).toHaveBeenCalledWith('partner_quote_rate', { p_quote_for: 'partner', p_partner_id: 'p1' });
  });
});

describe('useStaffPortfolioRate', () => {
  const route = (enabled: boolean, personRate: number | null) =>
    mocks.rpc.mockImplementation(async (fn: string) =>
      fn === 'get_partner_return_policy' ? policy(enabled) : { data: personRate, error: null });

  it("switch seen off: today's prefill, always sent", async () => {
    route(false, 20);
    const { result } = renderHook(() => useStaffPortfolioRate('p1', '15'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.switchOffSeen).toBe(true));
    await waitFor(() => expect(result.current.value).toBe('15'));
    expect(result.current.requestFields()).toEqual({ fields: { roi_percentage: 15, policy_enabled_seen: false } });
  });

  it("switch on: prefill is the partner's own rate, sent only when edited", async () => {
    route(true, 20);
    const { result } = renderHook(() => useStaffPortfolioRate('p1', '15'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.policyEnabled).toBe(true));
    await waitFor(() => expect(result.current.value).toBe('20'));
    expect(result.current.requestFields()).toEqual({ fields: { policy_enabled_seen: true } });
    act(() => result.current.setValue('25'));
    expect(result.current.edited).toBe(true);
    expect(result.current.requestFields()).toEqual({ fields: { roi_percentage: 25, policy_enabled_seen: true } });
  });

  it('switch on, partner rate unknown: blank prefill, nothing sent', async () => {
    route(true, null);
    const { result } = renderHook(() => useStaffPortfolioRate('p1', '15'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.policyEnabled).toBe(true));
    expect(result.current.value).toBe('');
    expect(result.current.requestFields()).toEqual({ fields: { policy_enabled_seen: true } });
  });

  it('policy unreadable: never the always-send branch', async () => {
    mocks.rpc.mockImplementation(async (fn: string) =>
      fn === 'get_partner_return_policy' ? { data: null, error: { message: 'down' } } : { data: 20, error: null });
    const { result } = renderHook(() => useStaffPortfolioRate('p1', '15'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.value).toBe('20'));
    expect(result.current.policyEnabled).toBeNull();
    expect(result.current.requestFields()).toEqual({ fields: { policy_enabled_seen: false } });
  });
});
