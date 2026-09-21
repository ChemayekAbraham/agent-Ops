import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type {
  FunderNewEmptyHouse,
  FunderNewFilters,
  FunderNewListResult,
  FunderNewMarketSummary,
  FunderNewReadyPlan,
} from './types';
import { amountRange, matchesReadyPlanSearch, toNumber } from './utils';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const normalizeTextFilter = (value: string) => {
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

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

export function useFunderNewEmptyHouses(filters: FunderNewFilters, limit: number, enabled: boolean) {
  return useQuery<FunderNewListResult<FunderNewEmptyHouse>>({
    queryKey: ['funder-new', 'empty-houses', filters, limit],
    enabled,
    queryFn: async () => {
      const range = amountRange(filters.amount);
      const { data, error } = await supabase.rpc('agent_list_empty_house_opportunities', {
        p_search: normalizeTextFilter(filters.search),
        p_limit: limit,
        p_offset: 0,
        p_district: normalizeTextFilter(filters.location),
        p_verified_only: true,
        p_gps_only: false,
        p_min_rent: range.min,
        p_max_rent: range.max,
        p_near_lat: null,
        p_near_lng: null,
        p_radius_km: null,
        p_sort: 'newest',
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

export function useFunderNewReadyPlans(filters: FunderNewFilters, limit: number, enabled: boolean) {
  return useQuery<FunderNewListResult<FunderNewReadyPlan>>({
    queryKey: ['funder-new', 'ready-plans', filters, limit],
    enabled,
    queryFn: async () => {
      const range = amountRange(filters.amount);
      const { data, error } = await supabase.rpc('partner_self_list_fundable_plans', {
        p_city: normalizeTextFilter(filters.location),
        p_limit: limit,
        p_offset: 0,
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
          ? 'Ready-tenant search is applied to the loaded results because the existing read service supports city and amount filters, not full text search.'
          : null,
      };
    },
    staleTime: 60_000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
