/**
 * Tests for the in-session pagination cache used by the tenant/funder
 * "Available Houses" sheet (`useNearbyHouses` in useHouseListings.ts).
 *
 * The cache (module-scoped `NEARBY_CACHE`) must:
 *   1. Restore the EXACT same accumulated pages when the sheet is closed and
 *      reopened (hook unmount + remount) with the same filter set — with zero
 *      new RPC calls.
 *   2. Restore a previously-viewed filter set when the user switches filters
 *      away and back — again with no re-fetch.
 *   3. Preserve the scroll cursor so `loadMore` continues from where it stopped.
 *   4. Be bypassed by `refresh()`, which forces a fresh fetch.
 *
 * The Supabase client is mocked so no network is used; we count how many times
 * the paginated RPC (`find_nearby_houses`) is invoked to prove cache hits.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// ---- Mock the Supabase client BEFORE importing the hook ----
const rpcCalls = { find_nearby_houses: 0, get_listing_agent_contacts: 0 };

/** Deterministic dataset per filter set so switching filters returns distinct rows. */
function buildDataset(region: string | null, category: string | null) {
  const prefix = `${region ?? 'all'}__${category ?? 'any'}`;
  return Array.from({ length: 60 }, (_, i) => ({
    id: `${prefix}-${String(i).padStart(3, '0')}`,
    title: `House ${i}`,
    description: null,
    house_category: category ?? 'single_room',
    number_of_rooms: 1,
    monthly_rent: 100000,
    daily_rate: 4000,
    access_fee: 0,
    platform_fee: 0,
    total_monthly_cost: 100000,
    region: region ?? 'Central',
    district: null,
    address: 'addr',
    latitude: 0.3 + i * 0.001,
    longitude: 32.5 + i * 0.001,
    has_water: true,
    has_electricity: true,
    has_security: true,
    has_parking: true,
    is_furnished: false,
    image_urls: ['https://example.com/photo.jpg'], // real photo so it isn't filtered out
    status: 'available',
    verified: true,
    created_at: new Date(Date.now() - i * 1000).toISOString(),
    distance_km: i, // already sorted ascending
  }));
}

vi.mock('@/integrations/supabase/client', () => {
  const rpc = vi.fn((name: string, params: Record<string, unknown>) => {
    if (name === 'find_nearby_houses') {
      rpcCalls.find_nearby_houses += 1;
      const rows = buildDataset(
        (params.region_filter as string | null) ?? null,
        (params.category_filter as string | null) ?? null,
      );
      const offset = Number(params.result_offset) || 0;
      const limit = Number(params.result_limit) || 24;
      return Promise.resolve({ data: rows.slice(offset, offset + limit), error: null });
    }
    if (name === 'get_listing_agent_contacts') {
      rpcCalls.get_listing_agent_contacts += 1;
      return Promise.resolve({ data: [], error: null });
    }
    return Promise.resolve({ data: [], error: null });
  });
  return { supabase: { rpc } };
});

import { useNearbyHouses, clearNearbyHousesCache } from './useHouseListings';

const PAGE = 24;
const baseOpts = {
  latitude: 0.3476,
  longitude: 32.5825,
  radiusKm: 100000,
  paginate: true,
  pageSize: PAGE,
};

function optionsFor(region?: string, category?: string) {
  return { ...baseOpts, region, category };
}

beforeEach(() => {
  clearNearbyHousesCache();
  rpcCalls.find_nearby_houses = 0;
  rpcCalls.get_listing_agent_contacts = 0;
});

describe('useNearbyHouses in-session cache', () => {
  it('restores the exact same results with no new RPC calls when the sheet reopens', async () => {
    // First open: load page 1, then page 2.
    const first = renderHook((props) => useNearbyHouses(props), { initialProps: optionsFor('Central') });
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    act(() => first.result.current.loadMore());
    await waitFor(() => expect(first.result.current.listings.length).toBe(2 * PAGE));

    const snapshot = first.result.current.listings.map((l) => l.id);
    const callsAfterFirst = rpcCalls.find_nearby_houses;
    expect(callsAfterFirst).toBe(2); // two pages fetched

    // Close the sheet.
    first.unmount();

    // Reopen with the identical filter set.
    const second = renderHook((props) => useNearbyHouses(props), { initialProps: optionsFor('Central') });
    await waitFor(() => expect(second.result.current.listings.length).toBe(2 * PAGE));

    // Same rows, same order, restored from cache with zero extra RPC calls.
    expect(second.result.current.listings.map((l) => l.id)).toEqual(snapshot);
    expect(second.result.current.metrics.cacheHit).toBe(true);
    expect(rpcCalls.find_nearby_houses).toBe(callsAfterFirst);
    second.unmount();
  });

  it('preserves the scroll cursor so loadMore continues after a reopen', async () => {
    const first = renderHook((props) => useNearbyHouses(props), { initialProps: optionsFor('Central') });
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.listings.length).toBe(PAGE); // one page loaded
    first.unmount();

    const second = renderHook((props) => useNearbyHouses(props), { initialProps: optionsFor('Central') });
    await waitFor(() => expect(second.result.current.listings.length).toBe(PAGE));
    expect(second.result.current.metrics.cacheHit).toBe(true);
    const callsBeforeMore = rpcCalls.find_nearby_houses;

    // Continue paginating from the cached cursor — fetches page 2 only.
    act(() => second.result.current.loadMore());
    await waitFor(() => expect(second.result.current.listings.length).toBe(2 * PAGE));
    expect(rpcCalls.find_nearby_houses).toBe(callsBeforeMore + 1);

    // No duplicates across the page boundary.
    const ids = second.result.current.listings.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    second.unmount();
  });

  it('restores a previous filter set when switching filters away and back', async () => {
    const { result, rerender, unmount } = renderHook((props) => useNearbyHouses(props), {
      initialProps: optionsFor('Central'),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const centralSnapshot = result.current.listings.map((l) => l.id);
    expect(rpcCalls.find_nearby_houses).toBe(1);

    // Switch to a different region — a fresh fetch.
    rerender(optionsFor('Eastern'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.listings[0].id.startsWith('Eastern')).toBe(true);
    expect(rpcCalls.find_nearby_houses).toBe(2);

    const callsBeforeSwitchBack = rpcCalls.find_nearby_houses;

    // Switch back to the original filter — restored from cache, no re-fetch.
    rerender(optionsFor('Central'));
    await waitFor(() => expect(result.current.metrics.cacheHit).toBe(true));
    expect(result.current.listings.map((l) => l.id)).toEqual(centralSnapshot);
    expect(rpcCalls.find_nearby_houses).toBe(callsBeforeSwitchBack);
    unmount();
  });

  it('refresh() bypasses the cache and refetches', async () => {
    const { result, unmount } = renderHook((props) => useNearbyHouses(props), {
      initialProps: optionsFor('Central'),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(rpcCalls.find_nearby_houses).toBe(1);

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.metrics.cacheHit).toBe(false));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(rpcCalls.find_nearby_houses).toBe(2); // forced a fresh page-1 fetch
    unmount();
  });
});
