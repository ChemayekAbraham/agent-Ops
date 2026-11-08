import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));

import * as browser from '@/lib/partnerReturnPolicy';
import * as shared from '../../../supabase/functions/_shared/partnerReturnPolicy';
import { usePartnerReturnPolicy } from '@/hooks/usePartnerReturnPolicy';

const POLICY_ON = { enabled: true, new_contract_rate: 10, cutoff_at: '2026-12-01T00:00:00Z', enabled_at: '2026-12-01T00:00:00Z', updated_at: '2026-12-01T00:00:00Z' };
const POLICY_OFF = { enabled: false, new_contract_rate: 15, cutoff_at: null, enabled_at: null, updated_at: '2026-11-05T00:00:00Z' };

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
}

describe('src/lib/partnerReturnPolicy re-exports the one shared module', () => {
  it('exposes the same functions (no browser copy of the rules)', () => {
    for (const name of ['rateOrNull', 'storedRate', 'typedRate', 'rateAwaitsCfo', 'formatRatePct', 'monthlyReturnFor', 'parsePublicPolicy', 'readQuoteRate'] as const) {
      expect(browser[name]).toBe(shared[name]);
    }
  });

  it('never answers with a default rate', () => {
    expect(browser.rateOrNull(undefined)).toBeNull();
    expect(browser.monthlyReturnFor(300_000, null)).toBeNull();
    expect(browser.formatRatePct(null)).toBeNull();
    expect(browser.parsePublicPolicy({ enabled: true })).toBeNull();
    expect(browser.parsePublicPolicy(null)).toBeNull();
  });

  it("keeps today's figures at 15", () => {
    for (const a of [1, 7, 33, 99_999, 300_000, 1_234_567]) expect(browser.monthlyReturnFor(a, 15)).toBe(Math.round(a * 0.15));
    expect(browser.formatRatePct(12.5)).toBe('12.5%');
  });
});

describe('usePartnerReturnPolicy', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    localStorage.clear();
  });
  afterEach(() => localStorage.clear());

  it('answers null (never 15) when the policy cannot be read', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { result } = renderHook(() => usePartnerReturnPolicy(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 4000 }); // the hook retries once
    expect(result.current.newContractRate).toBeNull();
    expect(result.current.enabled).toBeNull();
    expect(result.current.policy).toBeNull();
    expect(result.current.fromNetwork).toBe(false);
  });

  it('answers null for a malformed policy', async () => {
    mocks.rpc.mockResolvedValue({ data: { enabled: 'yes', new_contract_rate: -1 }, error: null });
    const { result } = renderHook(() => usePartnerReturnPolicy(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 4000 }); // the hook retries once
    expect(result.current.newContractRate).toBeNull();
  });

  it('reads the live switch and rate from the network', async () => {
    mocks.rpc.mockResolvedValue({ data: POLICY_ON, error: null });
    const { result } = renderHook(() => usePartnerReturnPolicy(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.fromNetwork).toBe(true));
    expect(result.current.enabled).toBe(true);
    expect(result.current.newContractRate).toBe(10);
    expect(result.current.cutoffAt).toBe('2026-12-01T00:00:00Z');
    expect(mocks.rpc).toHaveBeenCalledWith('get_partner_return_policy');
  });

  it('a remembered answer shows at once but is not fromNetwork', async () => {
    localStorage.setItem('welile.partnerReturnPolicy.v2', JSON.stringify(POLICY_OFF));
    let resolve: (v: unknown) => void = () => {};
    mocks.rpc.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { result } = renderHook(() => usePartnerReturnPolicy(), { wrapper: wrapper() });
    expect(result.current.newContractRate).toBe(15);
    expect(result.current.fromNetwork).toBe(false);
    resolve({ data: POLICY_ON, error: null });
    await waitFor(() => expect(result.current.fromNetwork).toBe(true));
    expect(result.current.newContractRate).toBe(10);
  });

  it('fresh (staff forms): ignores the remembered answer until this mount has fetched', async () => {
    localStorage.setItem('welile.partnerReturnPolicy.v2', JSON.stringify(POLICY_OFF));
    let resolve: (v: unknown) => void = () => {};
    mocks.rpc.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { result } = renderHook(() => usePartnerReturnPolicy({ fresh: true }), { wrapper: wrapper() });
    expect(result.current.enabled).toBeNull();
    expect(result.current.newContractRate).toBeNull();
    resolve({ data: POLICY_OFF, error: null });
    await waitFor(() => expect(result.current.fromNetwork).toBe(true));
    expect(result.current.enabled).toBe(false);
  });

  it('ignores a malformed remembered answer', () => {
    localStorage.setItem('welile.partnerReturnPolicy.v2', JSON.stringify({ enabled: false }));
    mocks.rpc.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => usePartnerReturnPolicy(), { wrapper: wrapper() });
    expect(result.current.newContractRate).toBeNull();
  });

  it('fresh: another screen\'s cached answer is not reused, and the mount counts as loading until its own fetch answers', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const shared = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
    mocks.rpc.mockResolvedValueOnce({ data: POLICY_OFF, error: null });
    const display = renderHook(() => usePartnerReturnPolicy(), { wrapper: shared });
    await waitFor(() => expect(display.result.current.enabled).toBe(false));

    let resolve: (v: unknown) => void = () => {};
    mocks.rpc.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const staff = renderHook(() => usePartnerReturnPolicy({ fresh: true }), { wrapper: shared });
    expect(staff.result.current.enabled).toBeNull();
    expect(staff.result.current.isLoading).toBe(true); // query.isLoading alone is false here (cache holds data)
    resolve({ data: POLICY_ON, error: null });
    await waitFor(() => expect(staff.result.current.fromNetwork).toBe(true));
    expect(staff.result.current.isLoading).toBe(false);
    expect(staff.result.current.enabled).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it('fresh: a failed refetch leaves the switch unknown (never the remembered off)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const shared = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
    mocks.rpc.mockResolvedValueOnce({ data: POLICY_OFF, error: null });
    const display = renderHook(() => usePartnerReturnPolicy(), { wrapper: shared });
    await waitFor(() => expect(display.result.current.enabled).toBe(false));

    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'down' } });
    const staff = renderHook(() => usePartnerReturnPolicy({ fresh: true }), { wrapper: shared });
    await waitFor(() => expect(staff.result.current.isLoading).toBe(false), { timeout: 4000 }); // the hook retries once
    expect(staff.result.current.enabled).toBeNull();
    expect(staff.result.current.fromNetwork).toBe(false);
  });
});
