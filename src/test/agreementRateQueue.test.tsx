import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor, act } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
import { usePartnerRateRequests, useDecidePartnerRateRequests } from '@/hooks/usePartnerRateApprovals';
const wrapper = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};
beforeEach(() => mocks.rpc.mockReset());
it('includes agreement requests without portfolios in the CFO queue', async () => {
  mocks.rpc.mockImplementation(async (fn: string) => ({ data: fn === 'list_agreement_rate_requests'
    ? [{ request_id: 'agreement', portfolio_id: null, source: 'agreement_rate', requested_rate: 20, requested_at: '2026-11-13T10:00:00Z' }]
    : [{ request_id: 'portfolio', portfolio_id: 'p1', source: 'rate_change', requested_rate: 25, requested_at: '2026-11-12T10:00:00Z' }], error: null }));
  const { result } = renderHook(() => usePartnerRateRequests('pending'), { wrapper: wrapper() });
  await waitFor(() => expect(result.current.data).toHaveLength(2));
  expect(result.current.data?.[0]).toMatchObject({ request_id: 'agreement', portfolio_id: null, requested_rate: 20 });
});
it('routes agreement and existing portfolio decisions to their own server functions', async () => {
  mocks.rpc.mockResolvedValue({ data: { decided: 1, skipped: 0 }, error: null });
  const { result } = renderHook(() => useDecidePartnerRateRequests(), { wrapper: wrapper() });
  await act(async () => {
    const answer = await result.current.mutateAsync({ requestIds: ['portfolio'], agreementRequestIds: ['agreement'], decision: 'approve' });
    expect(answer).toMatchObject({ decided: 2, skipped: 0, decision: 'approved' });
  });
  expect(mocks.rpc).toHaveBeenCalledWith('cfo_decide_agreement_rate_requests', { p_request_ids: ['agreement'], p_decision: 'approve', p_note: null });
  expect(mocks.rpc).toHaveBeenCalledWith('cfo_decide_portfolio_rate_requests', { p_request_ids: ['portfolio'], p_decision: 'approve', p_note: null });
});