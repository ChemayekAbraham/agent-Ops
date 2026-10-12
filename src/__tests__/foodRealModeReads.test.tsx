import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * The REAL (non-fixture) read path of useFoodService. Every other food test
 * runs against the fixture backend, which is how three defects reached the
 * real path unseen (master register FM-02, FM-03, FM-14):
 *   - orders were read with select('*'), so `order.items` was undefined and
 *     My orders, the order dialog and the kitchen queue crashed;
 *   - `mineOnly` was ignored, so the Food Coordinator's "My orders" listed
 *     every employee's orders (RLS lets the coordinator read all of them);
 *   - employee and coordinator names never arrived.
 */

const ME = 'f0000000-0000-4000-8000-0000000000a1';
const OTHER = 'f0000000-0000-4000-8000-0000000000b1';

type Call = { table: string; ops: Array<[string, unknown[]]> };
const calls: Call[] = [];
const rpcCalls: Array<[string, unknown]> = [];
const authListeners: Array<(event: string) => void> = [];
let rows: Record<string, unknown>[] = [];

function builder(table: string) {
  const call: Call = { table, ops: [] };
  calls.push(call);
  const b: Record<string, unknown> = {};
  for (const op of ['select', 'eq', 'is', 'order', 'limit']) {
    b[op] = (...args: unknown[]) => { call.ops.push([op, args]); return b; };
  }
  b.then = (resolve: (v: unknown) => void) => resolve({ data: rows, error: null });
  return b;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => builder(t),
    rpc: (fn: string, args: unknown) => {
      rpcCalls.push([fn, args]);
      return Promise.resolve({
        data: fn === 'food_people_names' ? [{ user_id: OTHER, full_name: 'TEST OTHER' }]
          : fn === 'food_can_use_canteen' ? true
          : fn === 'food_raise_exception' ? { exception_id: 'x', kind: 'other', raised_via: 'employee' }
          : fn === 'is_food_coordinator' || fn === 'is_active_food_coordinator' ? false
          : null,
        error: null,
      });
    },
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: ME } } }),
      onAuthStateChange: (cb: (event: string) => void) => {
        authListeners.push(cb);
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
    },
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// the real service, explicitly: no fixture opt-in
vi.stubEnv('VITE_FOOD_SERVICE_MOCK', '');

import {
  useMyFoodOrders, useFoodOrders, isFoodMockMode, useFoodCanUseCanteen, useRaiseFoodException,
  useFoodCoordinatorStatus,
} from '@/hooks/useFoodService';
import { act } from '@testing-library/react';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => { calls.length = 0; rpcCalls.length = 0; rows = []; });

describe('real-mode food reads', () => {
  it('runs against the real service when the fixture is not opted into', () => {
    expect(isFoodMockMode()).toBe(false);
  });

  it('embeds order lines so order.items exists (FM-02)', async () => {
    rows = [{ id: 'o1', employee_id: ME, placed_at: '2026-10-12T08:00:00Z', items: [] }];
    const { result } = renderHook(() => useMyFoodOrders(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const orders = calls.find((c) => c.table === 'food_orders')!;
    expect(orders.ops).toContainEqual(['select', ['*, items:food_order_items(*)']]);
    expect(result.current.data?.[0].items).toEqual([]);
  });

  it('filters "my orders" to the signed-in user explicitly (FM-03)', async () => {
    const { result } = renderHook(() => useMyFoodOrders(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const orders = calls.find((c) => c.table === 'food_orders')!;
    expect(orders.ops).toContainEqual(['eq', ['employee_id', ME]]);
  });

  it('reads newest orders first with a server-side cap', async () => {
    const { result } = renderHook(() => useMyFoodOrders(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const orders = calls.find((c) => c.table === 'food_orders')!;
    expect(orders.ops).toContainEqual(['order', ['placed_at', { ascending: false }]]);
    expect(orders.ops.some(([op]) => op === 'limit')).toBe(true);
  });

  it('attaches employee names on the coordinator order list (FM-14)', async () => {
    rows = [{ id: 'o2', employee_id: OTHER, placed_at: '2026-10-12T09:00:00Z', items: [] }];
    const { result } = renderHook(() => useFoodOrders('2026-10-12'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(rpcCalls).toContainEqual(['food_people_names', { p_ids: [OTHER] }]);
    expect(result.current.data?.[0].employee_name).toBe('TEST OTHER');
    // the coordinator list is a day list, not "mine": no employee filter
    const orders = calls.find((c) => c.table === 'food_orders')!;
    expect(orders.ops.some(([op, a]) => op === 'eq' && a[0] === 'employee_id')).toBe(false);
  });
});

describe('real-mode completion hooks', () => {
  it('asks the server whether this user may use the canteen (FM-26f)', async () => {
    const { result } = renderHook(() => useFoodCanUseCanteen(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(rpcCalls.some(([fn]) => fn === 'food_can_use_canteen')).toBe(true);
    expect(result.current.data).toBe(true);
  });

  it('sends kind, description and order when reporting a problem (FM-21)', async () => {
    const { result } = renderHook(() => useRaiseFoodException(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ kind: 'wrong_or_missing_item', note: 'No beans', orderId: 'o1' });
    });
    expect(rpcCalls).toContainEqual(['food_raise_exception',
      { p_kind: 'wrong_or_missing_item', p_note: 'No beans', p_order_id: 'o1' }]);
  });

  it('drops cached Food answers when the signed-in user changes (FM-24)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const w = ({ children }: { children: ReactNode }) =>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useFoodCoordinatorStatus(), { wrapper: w });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(qc.getQueryCache().findAll({ queryKey: ['food'] }).length).toBeGreaterThan(0);
    const calls = () => rpcCalls.filter(([fn]) => fn === 'is_food_coordinator').length;
    const before = calls();
    act(() => { for (const cb of authListeners) cb('SIGNED_IN'); });
    // the previous user's answer is not reused: the status is fetched again
    await waitFor(() => expect(calls()).toBeGreaterThan(before));
  });
});
