import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type {
  FunderNewEmptyHouse,
  FunderNewFilters,
  FunderNewListResult,
  FunderNewMarketSummary,
  FunderNewOrigin,
  FunderNewReadyPlan,
} from './types';
import { amountRange, matchesReadyPlanSearch, toNumber } from './utils';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const normalizeTextFilter = (value: string) => {
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

export const FUNDER_NEW_PAGE_SIZE = 6;
export const FUNDER_NEW_MORE_SIZE = 12;
/** The read RPC clamps p_limit to 100 — the map view can never exceed that. */
export const FUNDER_NEW_MAP_LIMIT = 100;

/** Rounded so small GPS jitter cannot churn the query key or refetch. */
export function stableOriginKey(origin: FunderNewOrigin | null): string | null {
  if (!origin) return null;
  return `${origin.source}:${origin.lat.toFixed(3)}:${origin.lng.toFixed(3)}:${origin.radiusKm ?? 'none'}`;
}

export function useFunderNewMarketSummary() {
  return useQuery<FunderNewMarketSummary>({
    queryKey: ['funder-new', 'empty-house-market-summary'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('empty_house_opportunity_summary');
      if (error) throw error;
      const raw = asRecord(data);
      const houseCount = toNumber(raw.house_count);
      const totalRentNeeded = toNumber(raw.total_rent_needed);
      const avgMonthlyRent = toNumber(raw.avg_monthly_rent) || (houseCount > 0 ? totalRentNeeded / houseCount : 0);
      return { houseCount, totalRentNeeded, avgMonthlyRent };
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Empty houses, sorted and filtered on the SERVER before the page limit, then
 * paged with p_offset. `origin` supplies p_near_lat/p_near_lng so the
 * 'nearest' sort applies to the whole eligible market, not to a loaded subset.
 */
export function useFunderNewEmptyHouses(
  filters: FunderNewFilters,
  origin: FunderNewOrigin | null,
  enabled: boolean,
) {
  const bucket = amountRange(filters.amount);
  // Typed rent bounds win over the coarse bucket, so the chip row is honest.
  const range = {
    min: filters.rentMin ?? bucket.min,
    max: filters.rentMax ?? bucket.max,
  };
  // 'nearest' needs coordinates; the RPC silently falls back otherwise, so the
  // route resolves the effective sort itself and shows the truth.
  const effectiveSort = filters.sort === 'nearest' && !origin ? 'recommended' : filters.sort;
  const nearby = effectiveSort === 'nearest' && origin ? origin : null;

  return useInfiniteQuery<FunderNewListResult<FunderNewEmptyHouse>>({
    queryKey: [
      'funder-new',
      'empty-houses',
      {
        search: filters.search.trim(),
        location: filters.location.trim(),
        amount: filters.amount,
        rentMin: filters.rentMin,
        rentMax: filters.rentMax,
        sort: effectiveSort,
      },
      stableOriginKey(nearby),
    ],
    enabled,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const offset = typeof pageParam === 'number' ? pageParam : 0;
      const { data, error } = await supabase.rpc('agent_list_empty_house_opportunities', {
        p_search: normalizeTextFilter(filters.search),
        p_limit: offset === 0 ? FUNDER_NEW_PAGE_SIZE : FUNDER_NEW_MORE_SIZE,
        p_offset: offset,
        p_district: normalizeTextFilter(filters.location),
        p_verified_only: true,
        // A strictly nearby result must exclude houses without a usable pin.
        p_gps_only: !!nearby,
        p_min_rent: range.min,
        p_max_rent: range.max,
        p_near_lat: nearby ? nearby.lat : null,
        p_near_lng: nearby ? nearby.lng : null,
        p_radius_km: nearby ? nearby.radiusKm : null,
        p_sort: effectiveSort,
      });
      if (error) throw error;
      const payload = asRecord(data);
      const houses = Array.isArray(payload.houses) ? (payload.houses as FunderNewEmptyHouse[]) : [];
      return { items: houses, total: toNumber(payload.total) || houses.length };
    },

    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, page) => sum + page.items.length, 0);
      if (lastPage.items.length === 0) return undefined;
      return loaded < lastPage.total ? loaded : undefined;
    },
    staleTime: 60_000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Houses that already have a ready tenant.
 *
 * LIMITATION, reported in the UI: `partner_self_list_fundable_plans` accepts
 * only city + amount + paging. It has no coordinate, radius or sort parameter,
 * so this path can never claim market-wide nearest ordering. Distances are
 * shown per plan where a pin exists, but the ordering is the service's own.
 */
export function useFunderNewReadyPlans(filters: FunderNewFilters, enabled: boolean) {
  const bucket = amountRange(filters.amount);
  const range = {
    min: filters.rentMin ?? bucket.min,
    max: filters.rentMax ?? bucket.max,
  };

  return useInfiniteQuery<FunderNewListResult<FunderNewReadyPlan>>({
    queryKey: [
      'funder-new',
      'ready-plans',
      {
        search: filters.search.trim(),
        location: filters.location.trim(),
        amount: filters.amount,
        rentMin: filters.rentMin,
        rentMax: filters.rentMax,
      },
    ],

    enabled,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const offset = typeof pageParam === 'number' ? pageParam : 0;
      const { data, error } = await supabase.rpc('partner_self_list_fundable_plans', {
        p_city: normalizeTextFilter(filters.location),
        p_limit: offset === 0 ? FUNDER_NEW_PAGE_SIZE : FUNDER_NEW_MORE_SIZE,
        p_offset: offset,
        p_min_amount: range.min,
        p_max_amount: range.max,
      });
      if (error) throw error;
      const payload = asRecord(data);
      const plans = Array.isArray(payload.plans) ? (payload.plans as FunderNewReadyPlan[]) : [];
      const filtered = plans.filter((plan) => matchesReadyPlanSearch(plan, filters));
      return {
        items: filtered,
        total: toNumber(payload.total) || plans.length,
        limitation: filters.search.trim()
          ? 'Tenant-ready search is applied to the results already loaded, because this read service supports city and amount only.'
          : null,
        rawCount: plans.length,
      } as FunderNewListResult<FunderNewReadyPlan> & { rawCount: number };
    },
    getNextPageParam: (lastPage, allPages) => {
      const rawLoaded = allPages.reduce(
        (sum, page) => sum + ((page as { rawCount?: number }).rawCount ?? page.items.length),
        0,
      );
      const raw = (lastPage as { rawCount?: number }).rawCount ?? lastPage.items.length;
      if (raw === 0) return undefined;
      return rawLoaded < lastPage.total ? rawLoaded : undefined;
    },
    staleTime: 60_000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Houses for the map view. Bounded to the RPC's 100-row ceiling and always
 * GPS-only, so every marker has a real pin. This is a view of the area, not the
 * whole market — the section says so.
 */
export function useFunderNewMapHouses(
  filters: FunderNewFilters,
  centre: { lat: number; lng: number } | null,
  radiusKm: number | null,
  enabled: boolean,
) {
  const range = amountRange(filters.amount);

  return useQuery<FunderNewListResult<FunderNewEmptyHouse>>({
    queryKey: [
      'funder-new',
      'map-houses',
      {
        search: filters.search.trim(),
        location: filters.location.trim(),
        amount: filters.amount,
      },
      centre ? `${centre.lat.toFixed(2)}:${centre.lng.toFixed(2)}` : null,
      radiusKm,
    ],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('agent_list_empty_house_opportunities', {
        p_search: normalizeTextFilter(filters.search),
        p_limit: FUNDER_NEW_MAP_LIMIT,
        p_offset: 0,
        p_district: normalizeTextFilter(filters.location),
        p_verified_only: true,
        p_gps_only: true,
        p_min_rent: range.min,
        p_max_rent: range.max,
        p_near_lat: centre ? centre.lat : null,
        p_near_lng: centre ? centre.lng : null,
        p_radius_km: centre ? radiusKm : null,
        p_sort: centre ? 'nearest' : 'recommended',
      });
      if (error) throw error;
      const payload = asRecord(data);
      const houses = Array.isArray(payload.houses) ? (payload.houses as FunderNewEmptyHouse[]) : [];
      return { items: houses, total: toNumber(payload.total) || houses.length };
    },
    staleTime: 60_000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Calculator recommendations: real eligible houses at or under the per-house
 * budget, nearest first when an origin exists. Server-side filtering and
 * limiting, so the result is a genuine market search within the stated range —
 * never a reordered sample of the six already on screen.
 */
export function useFunderNewRecommendations(
  perHouseAmount: number,
  count: number,
  filters: FunderNewFilters,
  origin: FunderNewOrigin | null,
  enabled: boolean,
) {
  const wanted = Math.max(1, Math.min(count, 50));
  return useQuery<FunderNewListResult<FunderNewEmptyHouse>>({
    queryKey: [
      'funder-new',
      'recommendations',
      perHouseAmount,
      wanted,
      { location: filters.location.trim(), search: filters.search.trim() },
      stableOriginKey(origin),
    ],
    enabled: enabled && perHouseAmount > 0,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('agent_list_empty_house_opportunities', {
        p_search: normalizeTextFilter(filters.search),
        p_limit: wanted,
        p_offset: 0,
        p_district: normalizeTextFilter(filters.location),
        p_verified_only: true,
        p_gps_only: !!origin,
        p_min_rent: null,
        p_max_rent: perHouseAmount,
        p_near_lat: origin ? origin.lat : null,
        p_near_lng: origin ? origin.lng : null,
        p_radius_km: origin ? origin.radiusKm : null,
        p_sort: origin ? 'nearest' : 'rent_low',
      });
      if (error) throw error;
      const payload = asRecord(data);
      const houses = Array.isArray(payload.houses) ? (payload.houses as FunderNewEmptyHouse[]) : [];
      return { items: houses, total: toNumber(payload.total) || houses.length };
    },
    staleTime: 60_000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
