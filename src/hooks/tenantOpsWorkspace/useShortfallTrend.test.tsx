import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

import { fetchShortfallTrend, useShortfallTrend } from './useShortfallTrend';

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

describe('useShortfallTrend', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks the server for the chosen number of days and maps strings to numbers', async () => {
    rpcMock.mockResolvedValue({
      data: [
        { day: '2026-10-05', expected_ugx: '8129123.00', collected_ugx: '1220970.00', short_ugx: '6908153.00', short_plans: 376, covered_pct: '15.0' },
        { day: '2026-09-07', expected_ugx: '0', collected_ugx: '0', short_ugx: '0', short_plans: 0, covered_pct: null },
      ],
      error: null,
    });
    const rows = await fetchShortfallTrend(30);
    expect(rpcMock).toHaveBeenCalledWith('tops_shortfall_daily_trend', { p_days: 30 });
    expect(rows[0]).toEqual({ day: '2026-10-05', expected_ugx: 8129123, collected_ugx: 1220970, short_ugx: 6908153, short_plans: 376, covered_pct: 15 });
    expect(rows[1].covered_pct).toBeNull();
  });

  it('throws the RPC error', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'not authorized' } });
    await expect(fetchShortfallTrend(7)).rejects.toMatchObject({ message: 'not authorized' });
  });

  it('refetches when the window changes', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    const { rerender } = renderHook(({ d }: { d: 7 | 30 | 90 }) => useShortfallTrend(d), { wrapper, initialProps: { d: 30 as 7 | 30 | 90 } });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('tops_shortfall_daily_trend', { p_days: 30 }));
    rerender({ d: 90 });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('tops_shortfall_daily_trend', { p_days: 90 }));
  });
});
