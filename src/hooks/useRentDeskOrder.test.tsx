import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a) },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'mgr-1' } }) }));

import {
  DEFAULT_RENT_DESK_SORT,
  fetchRentDeskOrder,
  nextRentDeskSort,
  orderByRentDesk,
  rentDeskIdsKey,
  withRentDeskScores,
  type RentDeskOrder,
  type RentDeskOrderRow,
} from './useRentDeskOrder';
import { useServiceCenterRentQueue } from './useServiceCenterRentQueue';

const orderRow = (id: string, rank: number, score: number | null): RentDeskOrderRow => ({
  request_id: id, tenant_id: `t-${id}`, rank, score, label: score == null ? null : 'average', reason: score == null ? null : `reason ${id}`, basis: score == null ? null : 'new',
});
const orderOf = (rows: RentDeskOrderRow[]): RentDeskOrder => ({ sort: 'best_payers', byId: new Map(rows.map((r) => [r.request_id, r])) });

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

beforeEach(() => {
  rpcMock.mockReset();
});

describe('rent desk order helpers', () => {
  it('the default sort is best payers first, and the toggle cycles through all three', () => {
    expect(DEFAULT_RENT_DESK_SORT).toBe('best_payers');
    expect(nextRentDeskSort('best_payers')).toBe('newest');
    expect(nextRentDeskSort('newest')).toBe('oldest');
    expect(nextRentDeskSort('oldest')).toBe('best_payers');
  });

  it('puts rows in the server rank, and unranked rows after the ranked ones in their own order', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'x' }, { id: 'c' }, { id: 'y' }];
    const order = orderOf([orderRow('c', 1, 80), orderRow('a', 2, 60), orderRow('b', 3, 40)]);
    expect(orderByRentDesk(rows, order).map((r) => r.id)).toEqual(['c', 'a', 'b', 'x', 'y']);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'x', 'c', 'y']); // not mutated
  });

  it('keeps the incoming order when there is no server order yet (loading or failed)', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    expect(orderByRentDesk(rows, undefined)).toBe(rows);
    expect(orderByRentDesk(rows, orderOf([]))).toBe(rows);
  });

  it('adds the score, label and reason the server returned and computes nothing itself', () => {
    const rows = [{ id: 'a' }, { id: 'z' }];
    const out = withRentDeskScores(rows, orderOf([orderRow('a', 1, 72)]));
    expect(out[0]).toMatchObject({ id: 'a', payment_score: 72, payment_label: 'average', payment_reason: 'reason a', payment_basis: 'new' });
    expect(out[1]).toEqual({ id: 'z' }); // not ranked: untouched
    expect(withRentDeskScores(rows, undefined)).toBe(rows);
  });

  it('keys a set of ids the same whatever order they come in, and differently for a different set', () => {
    expect(rentDeskIdsKey(['a', 'b', 'c'])).toBe(rentDeskIdsKey(['c', 'a', 'b']));
    expect(rentDeskIdsKey(['a', 'b', 'c'])).not.toBe(rentDeskIdsKey(['a', 'b', 'd']));
    expect(rentDeskIdsKey(['a', 'b', 'c'])).not.toBe(rentDeskIdsKey(['a', 'b']));
  });

  it('asks the one RPC for the order with the ids and the sort', async () => {
    rpcMock.mockResolvedValue({ data: [orderRow('a', 1, 50)], error: null });
    const order = await fetchRentDeskOrder(['a', 'b'], 'oldest');
    expect(rpcMock).toHaveBeenCalledWith('rent_request_desk_order', { p_request_ids: ['a', 'b'], p_sort: 'oldest' });
    expect(order.byId.get('a')?.rank).toBe(1);
  });

  it('throws when the RPC fails so a desk can fall back', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'Not authorized' } });
    await expect(fetchRentDeskOrder(['a'], 'best_payers')).rejects.toMatchObject({ message: 'Not authorized' });
  });
});

describe('useServiceCenterRentQueue', () => {
  const pending = ['r1', 'r2', 'r3'].map((id, i) => ({
    id, status: 'service_center_review', created_at: `2026-10-0${i + 1}T08:00:00Z`, tenant_id: `t-${id}`, tenant_name: id,
  }));
  const queue = { manager_id: 'mgr-1', is_service_center_manager: true, pending_count: 3, pending, recent_reviewed: [] };

  it('orders the pending queue by the server rank (best payers by default) and carries each score', async () => {
    rpcMock.mockImplementation(async (name: string, args: any) => {
      if (name === 'get_service_center_rent_queue') return { data: queue, error: null };
      expect(args.p_sort).toBe('best_payers');
      return { data: [orderRow('r3', 1, 90), orderRow('r1', 2, 55), orderRow('r2', 3, 20)], error: null };
    });
    const { result } = renderHook(() => useServiceCenterRentQueue(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.pending.map((r) => r.id)).toEqual(['r3', 'r1', 'r2']);
    expect(result.current.data?.pending[0]).toMatchObject({ payment_score: 90, payment_label: 'average' });
    expect(result.current.data?.pending_count).toBe(3);
  });

  it('passes the chosen sort to the server', async () => {
    rpcMock.mockImplementation(async (name: string) =>
      name === 'get_service_center_rent_queue' ? { data: queue, error: null } : { data: [orderRow('r1', 1, null), orderRow('r2', 2, null), orderRow('r3', 3, null)], error: null });
    const { result } = renderHook(() => useServiceCenterRentQueue('newest'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(rpcMock).toHaveBeenCalledWith('rent_request_desk_order', { p_request_ids: ['r1', 'r2', 'r3'], p_sort: 'newest' });
  });

  it('keeps the queue as it was returned if the ordering call fails', async () => {
    rpcMock.mockImplementation(async (name: string) =>
      name === 'get_service_center_rent_queue' ? { data: queue, error: null } : { data: null, error: { message: 'boom' } });
    const { result } = renderHook(() => useServiceCenterRentQueue(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.pending.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('does not ask for an order when the queue is empty', async () => {
    rpcMock.mockImplementation(async () => ({ data: { ...queue, pending: [], pending_count: 0 }, error: null }));
    const { result } = renderHook(() => useServiceCenterRentQueue(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('get_service_center_rent_queue', { p_manager_id: 'mgr-1' });
  });
});
