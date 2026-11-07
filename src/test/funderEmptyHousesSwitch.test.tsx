import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, type UseQueryOptions } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { maybeSingle, rpc, from, eq, select } = vi.hoisted(() => ({
  maybeSingle: vi.fn(), rpc: vi.fn(), from: vi.fn(), eq: vi.fn(), select: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from, rpc } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'funder-1' } }) }));
vi.mock('@/hooks/useAuthenticatedPoll', () => ({
  requireUserSession: vi.fn().mockResolvedValue(undefined), useAuthenticatedAudience: () => true,
}));
import {
  FUNDER_EMPTY_HOUSES_CACHE_MS, readFunderEmptyHousesSwitch, useFunderEmptyHousesAllowed,
} from '@/hooks/useFunderEmptyHousesSwitch';
import {
  useFunderNewEmptyHouses, useFunderNewReadyPlans, useFunderNewRecommendations,
} from '@/components/funder-new/useFunderNewOpportunities';
import type { FunderNewFilters } from '@/components/funder-new/types';

const filters: FunderNewFilters = {
  search: '', location: '', amount: 'all', sort: 'recommended', rentMin: null,
  rentMax: null, radiusKm: 'all', withinFloat: false,
};
const house = { house_id: 'empty-1', monthly_rent: 100000 };
const plan = { rent_request_id: 'verified-1', funding_amount: 100000 };
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

describe('funders_empty_houses visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    from.mockReturnValue({ select }); select.mockReturnValue({ eq }); eq.mockReturnValue({ maybeSingle });
    rpc.mockImplementation(async (name: string) => ({ error: null, data: name === 'partner_self_list_fundable_plans'
      ? { plans: [plan], total: 7 } : { houses: [house], total: 25 } }));
  });

  it('reads only the requested switch and allows strictly true', async () => {
    maybeSingle.mockResolvedValue({ data: { is_on: true }, error: null });
    expect(await readFunderEmptyHousesSwitch()).toBe(true);
    expect(from).toHaveBeenCalledWith('pipeline_switches');
    expect(select).toHaveBeenCalledWith('is_on');
    expect(eq).toHaveBeenCalledWith('key', 'funders_empty_houses');
  });
  it.each([false, null, undefined, 'true'])('hides empty houses for non-true is_on %s', async (is_on) => {
    maybeSingle.mockResolvedValue({ data: { is_on }, error: null });
    expect(await readFunderEmptyHousesSwitch()).toBe(false);
  });
  it('hides empty houses when the row is missing', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await readFunderEmptyHousesSwitch()).toBe(false);
  });
  it('hides empty houses on a server read error even if data is present', async () => {
    maybeSingle.mockResolvedValue({ data: { is_on: true }, error: { message: 'Denied' } });
    expect(await readFunderEmptyHousesSwitch()).toBe(false);
  });
  it('hides empty houses on a rejected network read', async () => {
    maybeSingle.mockRejectedValue(new Error('Offline'));
    expect(await readFunderEmptyHousesSwitch()).toBe(false);
  });
  it('shares the successful switch read for 60 seconds', async () => {
    maybeSingle.mockResolvedValue({ data: { is_on: true }, error: null });
    const { client, wrapper } = setup();
    const first = renderHook(useFunderEmptyHousesAllowed, { wrapper });
    await waitFor(() => expect(first.result.current).toBe(true));
    const second = renderHook(useFunderEmptyHousesAllowed, { wrapper });
    expect(second.result.current).toBe(true);
    expect(maybeSingle).toHaveBeenCalledTimes(1);
    const options = client.getQueryCache().find({ queryKey: ['funder-empty-houses-switch', 'funder-1'] })?.options as UseQueryOptions | undefined;
    expect(options?.staleTime)
      .toBe(FUNDER_EMPTY_HOUSES_CACHE_MS);
    expect(FUNDER_EMPTY_HOUSES_CACHE_MS).toBe(60000);
    first.unmount(); second.unmount(); client.clear();
  });
  it('removes cached listings, recommendations and their pagination totals after a failed refresh, preserving verified tenants', async () => {
    maybeSingle.mockResolvedValue({ data: { is_on: true }, error: null });
    const { client, wrapper } = setup();
    const view = renderHook(() => ({
      empty: useFunderNewEmptyHouses(filters, null, true),
      ready: useFunderNewReadyPlans(filters, true),
      recommended: useFunderNewRecommendations(100000, 3, filters, null, true),
    }), { wrapper });
    await waitFor(() => expect(view.result.current.empty.data?.pages[0].items).toEqual([house]));
    await waitFor(() => expect(view.result.current.recommended.data?.items).toEqual([house]));
    expect(view.result.current.empty.hasNextPage).toBe(true);
    maybeSingle.mockRejectedValue(new Error('Offline'));
    await act(async () => { await client.invalidateQueries({ queryKey: ['funder-empty-houses-switch'] }); });
    await waitFor(() => expect(view.result.current.empty.data).toBeUndefined());
    expect(view.result.current.empty.hasNextPage).toBe(false);
    expect(view.result.current.recommended.data).toBeUndefined();
    expect(view.result.current.ready.data?.pages[0]).toMatchObject({ items: [plan], total: 7 });
    rpc.mockClear();
    await act(async () => { await view.result.current.empty.refetch(); await view.result.current.empty.fetchNextPage(); });
    expect(rpc).not.toHaveBeenCalled();
    view.unmount(); client.clear();
  });
});