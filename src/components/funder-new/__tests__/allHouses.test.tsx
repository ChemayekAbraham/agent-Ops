import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) } }));
vi.mock('@/hooks/useAuthenticatedPoll', () => ({ requireUserSession: async () => {}, useAuthenticatedAudience: () => true }));
vi.mock('@/hooks/useFunderEmptyHousesSwitch', () => ({ useFunderEmptyHousesAllowed: () => true }));

import { useFunderNewEmptyHouses } from '../useFunderNewOpportunities';
import { feedCountLabel, orderFeedByBoardTag, withinRadius } from '../feedOrder';
import { tagKindFor } from '../FundersBoardTag';
import { BOARD_TAG_ORDER, fetchBoardItemTags, type BoardTag } from '@/lib/fundersBoard';
import type { FunderNewEmptyHouse, FunderNewFilters, FunderNewOrigin, FunderNewReadyPlan } from '../types';

const FILTERS: FunderNewFilters = { search: '', location: '', amount: 'all', sort: 'nearest', rentMin: null, rentMax: null, radiusKm: 'all', withinFloat: false };
const ORIGIN: FunderNewOrigin = { lat: 0.3476, lng: 32.5825, source: 'device', radiusKm: null, label: 'your location' };

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({ data: { houses: [], total: 783 }, error: null });
});

describe('all houses by default', () => {
  it('with a location and no distance chosen: nearest-first, no radius, houses without a pin kept', async () => {
    renderHook(() => useFunderNewEmptyHouses(FILTERS, ORIGIN, true), { wrapper });
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    const [fn, args] = rpcMock.mock.calls[0];
    expect(fn).toBe('agent_list_empty_house_opportunities');
    expect(args).toMatchObject({ p_sort: 'nearest', p_radius_km: null, p_gps_only: false, p_near_lat: ORIGIN.lat, p_near_lng: ORIGIN.lng });
  });

  it('any sort still sends the position (for distances) but never a radius by default', async () => {
    renderHook(() => useFunderNewEmptyHouses({ ...FILTERS, sort: 'recommended' }, ORIGIN, true), { wrapper });
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    expect(rpcMock.mock.calls[0][1]).toMatchObject({ p_sort: 'recommended', p_radius_km: null, p_gps_only: false, p_near_lat: ORIGIN.lat });
  });

  it('a distance the funder chooses limits the list (and needs a pin)', async () => {
    renderHook(() => useFunderNewEmptyHouses({ ...FILTERS, sort: 'recommended', radiusKm: 10 }, { ...ORIGIN, radiusKm: 10 }, true), { wrapper });
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    expect(rpcMock.mock.calls[0][1]).toMatchObject({ p_radius_km: 10, p_gps_only: true });
  });

  it('no location: no position, no radius', async () => {
    renderHook(() => useFunderNewEmptyHouses(FILTERS, null, true), { wrapper });
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    expect(rpcMock.mock.calls[0][1]).toMatchObject({ p_sort: 'recommended', p_radius_km: null, p_gps_only: false, p_near_lat: null });
  });

  it('withinRadius: only a chosen radius hides anything', () => {
    expect(withinRadius(197, null)).toBe(true);
    expect(withinRadius(null, null)).toBe(true);
    expect(withinRadius(3.2, 5)).toBe(true);
    expect(withinRadius(12, 5)).toBe(false);
    expect(withinRadius(null, 5)).toBe(false);
  });
});

type E = { category: 'ready' | 'empty'; item: FunderNewEmptyHouse | FunderNewReadyPlan; tag: BoardTag; km: number | null; rent: number };
const plan = (id: string, tag: BoardTag, km: number | null, rent = 500000): E => ({
  category: 'ready',
  item: { rent_request_id: id, rent_amount: rent, funding_amount: rent } as unknown as FunderNewReadyPlan,
  tag,
  km,
  rent,
});
const house = (id: string, km: number | null, rent = 300000): E => ({
  category: 'empty',
  item: { house_id: id, monthly_rent: rent } as unknown as FunderNewEmptyHouse,
  tag: 'empty_house',
  km,
  rent,
});
const ids = (list: E[]) => list.map((e) => ((e.item as { rent_request_id?: string }).rent_request_id ?? (e.item as { house_id?: string }).house_id));

describe('E65 order: tag group first, then the chosen sort', () => {
  const feed: E[] = [
    house('h-far', 197),
    plan('p-pending', 'pending_verification', 2),
    plan('p-verified-far', 'verified', 50),
    house('h-near', 3.2),
    plan('p-funded', 'funded', 1),
    plan('p-booked', 'booked', 9),
    plan('p-verified-near', 'verified', 4),
    house('h-nopin', null),
  ];

  it('Verified, Booked, Funded, Pending verification, Empty houses; nearest inside each group, no pin last', () => {
    const out = orderFeedByBoardTag(feed, (e) => e.tag, 'nearest', (e) => e.km);
    expect(ids(out)).toEqual(['p-verified-near', 'p-verified-far', 'p-booked', 'p-funded', 'p-pending', 'h-near', 'h-far', 'h-nopin']);
  });

  it('recommended keeps the order the reads returned inside each group', () => {
    const out = orderFeedByBoardTag(feed, (e) => e.tag, 'recommended', (e) => e.km);
    expect(ids(out)).toEqual(['p-verified-far', 'p-verified-near', 'p-booked', 'p-funded', 'p-pending', 'h-far', 'h-near', 'h-nopin']);
  });

  it('the group order is the server\'s (FB-ORDER)', () => {
    expect(Object.entries(BOARD_TAG_ORDER).sort((a, b) => a[1] - b[1]).map(([k]) => k)).toEqual([
      'verified', 'booked', 'funded', 'pending_verification', 'empty_house',
    ]);
  });

  it('the card tag follows the server tag, falling back to the category', () => {
    expect(tagKindFor('booked', 'ready')).toBe('booked');
    expect(tagKindFor('empty_house', 'empty')).toBe('empty');
    expect(tagKindFor(null, 'ready')).toBe('verified');
    expect(tagKindFor(undefined, 'empty')).toBe('empty');
  });

  it('reads the tags from funders_board_items', async () => {
    rpcMock.mockResolvedValueOnce({
      data: { items: [{ kind: 'rent_request', id: 'r1', tag: 'booked' }, { kind: 'rent_request', id: 'r2', tag: 'verified' }, { kind: 'rent_request', id: 'r3', tag: 'nonsense' }] },
      error: null,
    });
    const tags = await fetchBoardItemTags();
    expect(rpcMock).toHaveBeenCalledWith('funders_board_items', { p_tag: null, p_limit: 1000, p_offset: 0 });
    expect([...tags.entries()]).toEqual([['r1', 'booked'], ['r2', 'verified']]);
  });
});

describe('header count', () => {
  it('"16 ready to fund · 783 houses"', () => {
    expect(feedCountLabel(16, 783)).toBe('16 ready to fund · 783 houses');
    expect(feedCountLabel(2, 2532)).toBe('2 ready to fund · 2,532 houses');
    expect(feedCountLabel(0, 1)).toBe('0 ready to fund · 1 house');
  });
});
