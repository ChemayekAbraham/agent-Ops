import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface EmptyHouseTotalRentNeeded {
  totalRentNeeded: number;
  emptyCount: number;
}

/**
 * Current market-wide rent needed by all empty houses.
 *
 * Calls the same historical RPC for the current day and reads the latest
 * totals point, so the number is always fresh and filterable later.
 */
export function useEmptyHouseTotalRentNeeded(enabled = true) {
  return useQuery<EmptyHouseTotalRentNeeded>({
    queryKey: ['empty-house-total-rent-needed'],
    enabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase.rpc('map_empty_house_trend', {
        p_start: today,
        p_end: today,
        p_bucket: 'day',
        p_district: null,
        p_min_rent: null,
        p_max_rent: null,
        p_region_limit: 8,
      });
      if (error) throw error;
      const payload = (data ?? {}) as Record<string, unknown>;
      const totals = Array.isArray(payload.totals) ? payload.totals : [];
      const last = totals[totals.length - 1] as Record<string, unknown> | undefined;
      return {
        totalRentNeeded: Number(last?.rent_needed ?? 0),
        emptyCount: Number(last?.empty_count ?? 0),
      };
    },
  });
}
