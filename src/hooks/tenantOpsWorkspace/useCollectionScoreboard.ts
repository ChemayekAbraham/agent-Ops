/** Reads tops_collection_scoreboard() — the four figures, never a lone ratio, never clamped. */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface CollectionScoreboard {
  expected_ugx: number;
  collected_on_schedule_ugx: number;
  collected_arrears_ugx: number;
  total_cash_in_ugx: number;
  coverage_pct: number | null;
  basis: string;
  as_at: string;
}

async function fetchScoreboard(from: string, to: string): Promise<CollectionScoreboard> {
  const { data, error } = await anyDb.rpc('tops_collection_scoreboard', { p_from: from, p_to: to });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row as CollectionScoreboard;
}

export function useCollectionScoreboard(from: string, to: string) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'collectionScoreboard', from, to],
    queryFn: () => fetchScoreboard(from, to),
    staleTime: 60_000,
  });
}
