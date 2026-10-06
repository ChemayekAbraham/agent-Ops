/** Reads tops_shortfall_daily_trend(p_days) — expected, collected, short and short Rent Plans for each of the last 7 / 30 / 90 Kampala days. Every figure is computed in SQL. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export type ShortfallTrendDays = 7 | 30 | 90;

export interface ShortfallTrendPoint {
  /** yyyy-MM-dd, an Africa/Kampala date. The last point is today and is still moving. */
  day: string;
  expected_ugx: number;
  collected_ugx: number;
  short_ugx: number;
  short_plans: number;
  /** Percent of the day's bill collected (1 dp), computed by the server; null when nothing was billed. */
  covered_pct: number | null;
}

export async function fetchShortfallTrend(days: number): Promise<ShortfallTrendPoint[]> {
  const { data, error } = await anyDb.rpc('tops_shortfall_daily_trend', { p_days: days });
  if (error) throw error;
  return ((data ?? []) as Record<string, any>[]).map((r) => ({
    day: String(r.day),
    expected_ugx: Number(r.expected_ugx),
    collected_ugx: Number(r.collected_ugx),
    short_ugx: Number(r.short_ugx),
    short_plans: Number(r.short_plans),
    covered_pct: r.covered_pct === null || r.covered_pct === undefined ? null : Number(r.covered_pct),
  }));
}

export function useShortfallTrend(days: ShortfallTrendDays) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'shortfallTrend', days],
    queryFn: () => fetchShortfallTrend(days),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
}
