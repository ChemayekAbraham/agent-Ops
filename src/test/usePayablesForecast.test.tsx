import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
import { usePayablesPredictiveForecast } from '@/hooks/usePayables';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(() => usePayablesPredictiveForecast('day', 7), { wrapper }) };
}

describe('Payables forecast failure handling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not replay a statement timeout', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } });
    const { result, client, unmount } = setup();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBeUndefined();
    unmount(); client.clear();
  });

  it('does not replay a permission denial', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'Not authorised to view payables' } });
    const { result, client, unmount } = setup();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    unmount(); client.clear();
  });

  it('retries a transient failure once and returns the server figures unchanged', async () => {
    const forecast = { currency: 'UGX', periods: [{ forecast_amount: 150000 }] };
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } })
      .mockResolvedValueOnce({ data: forecast, error: null });
    const { result, client, unmount } = setup();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenCalledWith('get_payables_predictive_forecast', { p_granularity: 'day', p_periods: 7 });
    expect(result.current.data).toEqual(forecast);
    unmount(); client.clear();
  });

  it('stops after one retry when a transient failure persists', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'Failed to fetch' } });
    const { result, client, unmount } = setup();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    unmount(); client.clear();
  });
});