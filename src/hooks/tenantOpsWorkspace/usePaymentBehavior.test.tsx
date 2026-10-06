import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) } }));

import {
  fetchPaymentBehaviorBy, fetchPaymentBehaviorReportData, fetchPaymentBehaviorWatchlist, usePaymentBehaviorOverview,
} from './usePaymentBehavior';

const F = { startIso: '2026-10-01T00:00:00.000Z', endIso: '2026-10-06T23:59:59.999Z' };
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

describe('usePaymentBehavior readers', () => {
  beforeEach(() => { vi.clearAllMocks(); rpcMock.mockResolvedValue({ data: { rows: [] }, error: null }); });

  it('passes the range and every filter to the overview RPC, nulls when unset', async () => {
    rpcMock.mockResolvedValue({ data: { summary: {} }, error: null });
    renderHook(() => usePaymentBehaviorOverview({ ...F, agentId: 'a-1', region: 'Central', district: 'Wakiso', cadence: 'daily' }), { wrapper });
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    expect(rpcMock).toHaveBeenCalledWith('tops_payment_behaviour_overview', {
      p_start: F.startIso, p_end: F.endIso, p_agent_id: 'a-1', p_region: 'Central', p_district: 'Wakiso', p_cadence: 'daily',
    });
  });

  it('asks for a breakdown by dimension and returns its rows', async () => {
    rpcMock.mockResolvedValue({ data: { dimension: 'agent', rows: [{ key: 'a' }] }, error: null });
    const rows = await fetchPaymentBehaviorBy(F, 'agent', 50);
    expect(rpcMock).toHaveBeenCalledWith('tops_payment_behaviour_by', expect.objectContaining({ p_dimension: 'agent', p_limit: 50, p_agent_id: null }));
    expect(rows).toEqual([{ key: 'a' }]);
  });

  it('pages the watchlist on the server', async () => {
    rpcMock.mockResolvedValue({ data: { rows: [], total: 0 }, error: null });
    await fetchPaymentBehaviorWatchlist(F, { minScore: 3, limit: 20, offset: 40 });
    expect(rpcMock).toHaveBeenCalledWith('tops_payment_behaviour_watchlist', expect.objectContaining({ p_min_score: 3, p_limit: 20, p_offset: 40 }));
  });

  it('throws the server error', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'not authorized' } });
    await expect(fetchPaymentBehaviorBy(F, 'region')).rejects.toMatchObject({ message: 'not authorized' });
  });

  it('gathers everything the PDF needs with the same filters', async () => {
    rpcMock.mockImplementation((fn: string) => Promise.resolve({ data: fn === 'tops_payment_behaviour_by' ? { rows: [] } : {}, error: null }));
    const data = await fetchPaymentBehaviorReportData({ ...F, region: 'Central' });
    const fns = rpcMock.mock.calls.map((c) => c[0] as string);
    expect(fns.filter((f) => f === 'tops_payment_behaviour_by')).toHaveLength(6);
    expect(fns).toEqual(expect.arrayContaining(['tops_payment_behaviour_overview', 'tops_payment_behaviour_trend', 'tops_payment_behaviour_timing', 'tops_payment_behaviour_watchlist']));
    expect(rpcMock.mock.calls.every((c) => (c[1] as Record<string, unknown>).p_region === 'Central')).toBe(true);
    expect(Object.keys(data.byDimension)).toHaveLength(6);
  });
});
