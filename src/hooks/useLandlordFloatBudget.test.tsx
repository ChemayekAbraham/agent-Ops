import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
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

import { LANDLORD_FLOAT_BUDGET_KEY, useLandlordFloatBudgetActions, useLandlordFloatBudgetStatus } from './useLandlordFloatBudget';

const makeClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const wrapperFor = (qc: QueryClient) => ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

const position = (room: number) => ({
  day: '2026-10-16', week_start: '2026-10-12', week_end: '2026-10-18', blocked: false, blocked_reason: null, room,
  daily: { amount: 40_000_000, used: 40_000_000 - room, excess: 0 }, weekly: { amount: 200_000_000, used: 0, excess: 0 },
});

beforeEach(() => rpcMock.mockReset());

describe('useLandlordFloatBudget', () => {
  it('loads the status in one call', async () => {
    rpcMock.mockResolvedValue({ data: { ...position(5_000_000), today: '2026-10-16', can_approve: true, pending_misc: [] }, error: null });
    const qc = makeClient();
    const { result } = renderHook(() => useLandlordFloatBudgetStatus(), { wrapper: wrapperFor(qc) });
    await waitFor(() => expect(result.current.data?.room).toBe(5_000_000));
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('get_landlord_float_budget_status', undefined);
  });

  it('does not load when disabled (stages that have no budget)', () => {
    const qc = makeClient();
    renderHook(() => useLandlordFloatBudgetStatus({ enabled: false }), { wrapper: wrapperFor(qc) });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('approves a whole selection in one call and writes the returned position into the cache', async () => {
    const qc = makeClient();
    qc.setQueryData([...LANDLORD_FLOAT_BUDGET_KEY, 'status'], { ...position(5_000_000), can_approve: true, pending_misc: [] });
    rpcMock.mockResolvedValue({
      data: { approved: [{ id: 'a', rent_amount: 3_000_000 }], over_cap: [{ id: 'b', rent_amount: 4_000_000, room: 2_000_000 }],
              skipped: [], approved_total: 3_000_000, room_left: 2_000_000, status: position(2_000_000) },
      error: null,
    });
    const { result } = renderHook(() => useLandlordFloatBudgetActions(), { wrapper: wrapperFor(qc) });
    await act(async () => {
      await result.current.approveAtCoo.mutateAsync({ requestIds: ['a', 'b'], comment: '  ok  ' });
    });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('coo_approve_rent_requests', { p_request_ids: ['a', 'b'], p_comment: 'ok' });
    const cached = qc.getQueryData<{ room: number; can_approve: boolean }>([...LANDLORD_FLOAT_BUDGET_KEY, 'status']);
    expect(cached?.room).toBe(2_000_000);
    expect(cached?.can_approve).toBe(true); // viewer fields survive the merge
  });

  it('sends one reason per request for a miscellaneous ask, and surfaces server errors', async () => {
    const qc = makeClient();
    rpcMock.mockResolvedValueOnce({ data: { requested: [], skipped: [], requested_total: 0 }, error: null });
    const { result } = renderHook(() => useLandlordFloatBudgetActions(), { wrapper: wrapperFor(qc) });
    await act(async () => {
      await result.current.requestMisc.mutateAsync([{ rentRequestId: 'r1', reason: ' Landlord deadline today ' }]);
    });
    expect(rpcMock).toHaveBeenCalledWith('coo_request_landlord_float_misc', {
      p_items: [{ rent_request_id: 'r1', reason: 'Landlord deadline today' }],
    });

    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'OVER_WEEKLY_REASON_REQUIRED: give a reason' } });
    await expect(
      act(() => result.current.setBudget.mutateAsync({ periodType: 'daily', amount: 300_000_000 })),
    ).rejects.toThrow('OVER_WEEKLY_REASON_REQUIRED');
    expect(rpcMock).toHaveBeenLastCalledWith('cfo_set_landlord_float_budget', {
      p_period_type: 'daily', p_amount: 300_000_000, p_reason: null, p_period_start: null,
    });
  });

  it('returns requests to the COO with the reason', async () => {
    const qc = makeClient();
    rpcMock.mockResolvedValue({ data: { returned: [{ id: 'x', rent_amount: 1 }], skipped: [], returned_total: 1, status: position(1) }, error: null });
    const { result } = renderHook(() => useLandlordFloatBudgetActions(), { wrapper: wrapperFor(qc) });
    await act(async () => {
      await result.current.returnToCoo.mutateAsync({ requestIds: ['x'], reason: 'Landlord number mismatch' });
    });
    expect(rpcMock).toHaveBeenCalledWith('cfo_return_rent_requests_to_coo', { p_request_ids: ['x'], p_reason: 'Landlord number mismatch' });
  });
});
