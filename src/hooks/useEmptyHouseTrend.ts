import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Empty-house density and rent-needed history.
 *
 * The series is derived in the database from listing dates and funding dates,
 * so it answers "how many empty houses were waiting in this area, and how much
 * rent was needed" for any past date range without a snapshot backfill.
 */
export type TrendBucket = 'day' | 'week' | 'month';

export interface TrendPoint {
  bucket: string;
  emptyCount: number;
  rentNeeded: number;
}

export interface TrendRegion {
  region: string;
  series: TrendPoint[];
  firstCount: number;
  lastCount: number;
  countChange: number;
  firstRent: number;
  lastRent: number;
  rentChange: number;
}

export interface EmptyHouseTrend {
  bucket: TrendBucket;
  start: string;
  end: string;
  totals: TrendPoint[];
  regions: TrendRegion[];
}

export interface TrendParams {
  start: string;
  end: string;
  bucket: TrendBucket;
  district?: string | null;
  minRent?: number | null;
  maxRent?: number | null;
}

const toPoints = (raw: unknown): TrendPoint[] =>
  (Array.isArray(raw) ? raw : []).map((p) => {
    const row = (p ?? {}) as Record<string, unknown>;
    return {
      bucket: String(row.bucket ?? ''),
      emptyCount: Number(row.empty_count ?? 0),
      rentNeeded: Number(row.rent_needed ?? 0),
    };
  });

export function useEmptyHouseTrend(params: TrendParams, enabled = true) {
  return useQuery<EmptyHouseTrend>({
    queryKey: ['empty-house-trend', params],
    enabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('map_empty_house_trend', {
        p_start: params.start,
        p_end: params.end,
        p_bucket: params.bucket,
        p_district: params.district?.trim() ? params.district.trim() : null,
        p_min_rent: params.minRent ?? null,
        p_max_rent: params.maxRent ?? null,
        p_region_limit: 8,
      });
      if (error) throw error;
      const payload = (data ?? {}) as Record<string, unknown>;
      const regions = (Array.isArray(payload.regions) ? payload.regions : []).map((r) => {
        const row = (r ?? {}) as Record<string, unknown>;
        return {
          region: String(row.region ?? 'Unspecified area'),
          series: toPoints(row.series),
          firstCount: Number(row.first_count ?? 0),
          lastCount: Number(row.last_count ?? 0),
          countChange: Number(row.count_change ?? 0),
          firstRent: Number(row.first_rent ?? 0),
          lastRent: Number(row.last_rent ?? 0),
          rentChange: Number(row.rent_change ?? 0),
        } satisfies TrendRegion;
      });
      return {
        bucket: (String(payload.bucket ?? 'week') as TrendBucket),
        start: String(payload.start ?? params.start),
        end: String(payload.end ?? params.end),
        totals: toPoints(payload.totals),
        regions,
      };
    },
  });
}
