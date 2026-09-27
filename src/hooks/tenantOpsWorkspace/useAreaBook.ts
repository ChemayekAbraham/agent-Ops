/** Reads tops_area_book(p_level, p_as_at) — arrears rate and money at risk per administrative area. */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export type AreaLevel = 'region' | 'district' | 'county' | 'subcounty' | 'parish' | 'village';

export interface AreaBookRow {
  area_key: string | null;
  area_name: string;
  region: string | null;
  plan_count: number;
  arrears_plan_count: number;
  arrears_rate: number | null;
  money_at_risk_ugx: number;
}

async function fetchAreaBook(level: AreaLevel, asAt: string | null): Promise<AreaBookRow[]> {
  const { data, error } = await anyDb.rpc('tops_area_book', { p_level: level, p_as_at: asAt });
  if (error) throw error;
  return ((data ?? []) as Record<string, any>[]).map((r) => ({
    area_key: r.area_key ?? null,
    area_name: r.area_name,
    region: r.region ?? null,
    plan_count: Number(r.plan_count),
    arrears_plan_count: Number(r.arrears_plan_count),
    arrears_rate: r.arrears_rate != null ? Number(r.arrears_rate) : null,
    money_at_risk_ugx: Number(r.money_at_risk_ugx),
  }));
}

export function useAreaBook(level: AreaLevel, asAt: string | null) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'areaBook', level, asAt],
    queryFn: () => fetchAreaBook(level, asAt),
    staleTime: 60_000,
  });
}
