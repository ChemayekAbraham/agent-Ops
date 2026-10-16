import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
// like the real client, rpc only works when called on the client itself (a detached call has no `this`)
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rest: {},
    rpc(this: { rest?: unknown } | undefined, ...a: unknown[]) {
      if (!this?.rest) throw new TypeError("Cannot read properties of undefined (reading 'rest')");
      return rpcMock(...a);
    },
  },
}));

import { useTenantOpsRentLifetime } from './useTenantOpsRentLifetime';

const wrapper = (qc: QueryClient) => ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
beforeEach(() => rpcMock.mockReset());

describe('useTenantOpsRentLifetime', () => {
  it('calls the function with no arguments (no date range) and types the answer', async () => {
    rpcMock.mockResolvedValue({ data: { submitted: 6577, funded: 1742, financed: 1329, repayment: { full: 489, partial: 773, never_paid: 22, too_early: 45 } }, error: null });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useTenantOpsRentLifetime(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.data?.submitted).toBe(6577));
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('tenant_ops_rent_request_lifetime');
    expect(result.current.data?.repayment.partial).toBe(773);
  });

  it('is cached for 5 minutes and its key carries no date', async () => {
    rpcMock.mockResolvedValue({ data: { submitted: 1 }, error: null });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(() => useTenantOpsRentLifetime(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.data).not.toBeNull());
    rerender();
    expect(rpcMock).toHaveBeenCalledTimes(1);
    const q = qc.getQueryCache().find({ queryKey: ['tenant-ops-rent-lifetime'] });
    expect(q).toBeTruthy();
    expect(JSON.stringify(q!.queryKey)).toBe('["tenant-ops-rent-lifetime"]');
    expect((q!.options as { staleTime?: number }).staleTime).toBe(5 * 60_000);
  });

  it('surfaces an error and can retry', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'boom' } }).mockResolvedValueOnce({ data: { submitted: 3 }, error: null });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useTenantOpsRentLifetime(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    result.current.refetch();
    await waitFor(() => expect(result.current.data?.submitted).toBe(3));
  });
});
