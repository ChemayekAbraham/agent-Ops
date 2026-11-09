import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc, from, audience } = vi.hoisted(() => ({
  rpc: vi.fn(), from: vi.fn(), audience: { signedIn: true },
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from, rpc } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'funder-1' } }) }));
vi.mock('@/hooks/useAuthenticatedPoll', () => ({
  requireUserSession: vi.fn().mockResolvedValue(undefined), useAuthenticatedAudience: () => audience.signedIn,
}));
import { useFunderEmptyHousesAllowed } from '@/hooks/useFunderEmptyHousesSwitch';
import {
  useFunderNewEmptyHouses, useFunderNewReadyPlans, useFunderNewRecommendations,
  useFunderNewMapHouses, useFunderNewMarketSummary,
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
    audience.signedIn = true;
    rpc.mockImplementation(async (name: string) => ({ error: null, data: name === 'partner_self_list_fundable_plans'
      ? { plans: [plan], total: 7 } : name === 'empty_house_opportunity_summary'
      ? { house_count: 25, total_rent_needed: 2500000, districts: [] }
      : { houses: [house], total: 25 } }));
  });

  it('restores authenticated discovery without consulting the funding switch', () => {
    const { client, wrapper } = setup();
    const view = renderHook(useFunderEmptyHousesAllowed, { wrapper });
    expect(view.result.current).toBe(true);
    expect(from).not.toHaveBeenCalled();
    view.unmount(); client.clear();
  });
  it('preserves house amounts, pagination, recommendations, pins, totals and verified tenants', async () => {
    const { client, wrapper } = setup();
    const view = renderHook(() => ({
      empty: useFunderNewEmptyHouses(filters, null, true),
      ready: useFunderNewReadyPlans(filters, true),
      recommended: useFunderNewRecommendations(100000, 3, filters, null, true),
      map: useFunderNewMapHouses(filters, null, null, true),
      summary: useFunderNewMarketSummary(),
    }), { wrapper });
    await waitFor(() => expect(view.result.current.empty.data?.pages[0].items).toEqual([house]));
    await waitFor(() => expect(view.result.current.recommended.data?.items).toEqual([house]));
    expect(view.result.current.empty.hasNextPage).toBe(true);
    expect(view.result.current.empty.data?.pages[0].total).toBe(25);
    await waitFor(() => expect(view.result.current.map.data?.items).toEqual([house]));
    await waitFor(() => expect(view.result.current.summary.data?.totalRentNeeded).toBe(2500000));
    expect(view.result.current.ready.data?.pages[0]).toMatchObject({ items: [plan], total: 7 });
    expect(from).not.toHaveBeenCalled();
    expect(rpc.mock.calls.every(([name]) => !String(name).includes('fund_booked'))).toBe(true);
    view.unmount(); client.clear();
  });
  it('does not request discovery while signed out', () => {
    audience.signedIn = false;
    const { client, wrapper } = setup();
    const view = renderHook(() => ({
      allowed: useFunderEmptyHousesAllowed(),
      empty: useFunderNewEmptyHouses(filters, null, true),
    }), { wrapper });
    expect(view.result.current.allowed).toBe(false);
    expect(view.result.current.empty.data).toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
    view.unmount(); client.clear();
  });
});