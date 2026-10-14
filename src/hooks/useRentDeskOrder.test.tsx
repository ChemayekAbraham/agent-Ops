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
  filterByRentDesk,
  nextRentDeskSort,
  orderByRentDesk,
  rentDeskIdsKey,
  withRentDeskScores,
  type RentDeskOrder,
  type RentDeskOrderRow,
} from './useRentDeskOrder';
import { useServiceCenterRentQueue } from './useServiceCenterRentQueue';

const orderRow = (id: string, rank: number, score: number | null, matches = true, matchCount = 0, totalCount = 0): RentDeskOrderRow => ({
  request_id: id, tenant_id: `t-${id}`, rank, score, label: score == null ? null : 'average', reason: score == null ? null : `reason ${id}`, basis: score == null ? null : 'new',
  matches, match_count: matchCount, total_count: totalCount,
});
const orderOf = (rows: RentDeskOrderRow[], filtered = false): RentDeskOrder => ({
  sort: 'best_payers', filtered, matchCount: rows.filter((r) => r.matches).length, totalCount: rows.length, byId: new Map(rows.map((r) => [r.request_id, r])),
});

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
    expect(rpcMock).toHaveBeenCalledWith('rent_request_desk_order', {
      p_request_ids: ['a', 'b'], p_sort: 'oldest', p_labels: null, p_arrived: null, p_from: null, p_to: null,
    });
    expect(order.byId.get('a')?.rank).toBe(1);
  });

  it('sends the chosen filters to the same RPC', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    await fetchRentDeskOrder(['a'], 'best_payers', { labels: ['watch', 'proven_good'], arrived: 'custom', from: '2026-10-01', to: '2026-10-14' });
    expect(rpcMock).toHaveBeenCalledWith('rent_request_desk_order', {
      p_request_ids: ['a'], p_sort: 'best_payers', p_labels: ['proven_good', 'watch'], p_arrived: 'custom', p_from: '2026-10-01', p_to: '2026-10-14',
    });
  });

  it('reads the server count from the answer, and flags a filtered order', async () => {
    rpcMock.mockResolvedValue({ data: [orderRow('a', 1, 70, true, 1, 3), orderRow('b', 2, 40, false, 1, 3), orderRow('c', 3, 20, false, 1, 3)], error: null });
    const order = await fetchRentDeskOrder(['a', 'b', 'c'], 'best_payers', { labels: ['average'], arrived: 'any', from: null, to: null });
    expect(order).toMatchObject({ filtered: true, matchCount: 1, totalCount: 3 });
    const unfiltered = await fetchRentDeskOrder(['a', 'b', 'c'], 'best_payers');
    expect(unfiltered.filtered).toBe(false);
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
    const { result } = renderHook(() => useServiceCenterRentQueue({ sort: 'newest' }), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(rpcMock).toHaveBeenCalledWith('rent_request_desk_order', {
      p_request_ids: ['r1', 'r2', 'r3'], p_sort: 'newest', p_labels: null, p_arrived: null, p_from: null, p_to: null,
    });
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

  it('shows exactly the rows the server says match, and its count equals the server\'s count', async () => {
    // the mock marks r2 as the only match even though every row carries the same label: the client must not re-evaluate it
    rpcMock.mockImplementation(async (name: string, args: any) => {
      if (name === 'get_service_center_rent_queue') return { data: queue, error: null };
      expect(args.p_labels).toEqual(['watch']);
      expect(args.p_arrived).toBe('7d');
      return { data: [orderRow('r3', 1, 90, false, 1, 3), orderRow('r2', 2, 55, true, 1, 3), orderRow('r1', 3, 20, false, 1, 3)], error: null };
    });
    const filters = { labels: ['watch' as const], arrived: '7d' as const, from: null, to: null };
    const { result } = renderHook(() => useServiceCenterRentQueue({ filters }), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.pending.map((r) => r.id)).toEqual(['r2']);
    expect(result.current.data?.pending.length).toBe(result.current.desk.matchCount);
    expect(result.current.desk).toMatchObject({ matchCount: 1, totalCount: 3, filtered: true, error: false });
    expect(result.current.data?.pending_count).toBe(3); // the whole queue is still reported
  });

  it('shows every request, and says so, if the filter call fails', async () => {
    rpcMock.mockImplementation(async (name: string) =>
      name === 'get_service_center_rent_queue' ? { data: queue, error: null } : { data: null, error: { message: 'boom' } });
    const filters = { labels: ['watch' as const], arrived: 'any' as const, from: null, to: null };
    const { result } = renderHook(() => useServiceCenterRentQueue({ filters }), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.pending.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(result.current.desk.error).toBe(true);
  });

  it('makes no ordering call at all when only the counts are wanted', async () => {
    rpcMock.mockImplementation(async () => ({ data: queue, error: null }));
    const { result } = renderHook(() => useServiceCenterRentQueue({ ordered: false }), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(result.current.data?.pending_count).toBe(3);
  });
});

describe('the rows a desk shows under a filter', () => {
  const rows = ['a', 'b', 'c', 'd'].map((id) => ({ id }));

  it('keeps only the rows the server matched, in the server order, and the count equals the server\'s count', () => {
    const order = orderOf([orderRow('c', 1, 90, true), orderRow('a', 2, 70, false), orderRow('b', 3, 60, true), orderRow('d', 4, 10, false)], true);
    const shown = filterByRentDesk(orderByRentDesk(withRentDeskScores(rows, order), order), order);
    expect(shown.map((r) => r.id)).toEqual(['c', 'b']);
    expect(shown.length).toBe(order.matchCount);
    expect(shown.every((r) => r.desk_match === true)).toBe(true);
  });

  it('shows every row when no filter is set, or when there is no answer from the server', () => {
    expect(filterByRentDesk(rows, orderOf([orderRow('a', 1, 70, false)], false))).toBe(rows);
    expect(filterByRentDesk(rows, undefined)).toBe(rows);
  });

  it('hides a row the server did not rank when a filter is on', () => {
    const order = orderOf([orderRow('a', 1, 70, true)], true);
    expect(filterByRentDesk(rows, order).map((r) => r.id)).toEqual(['a']);
  });
});
