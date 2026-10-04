/** Reads tops_never_billed_summary() — a standalone count+total, same basis as the Never billed tab's own list. */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface NeverBilledSummary {
  as_at: string;
  count: number;
  arrears_ugx: number;
  basis: string;
}

async function fetchNeverBilledSummary(asAt: string | null): Promise<NeverBilledSummary> {
  const { data, error } = await anyDb.rpc('tops_never_billed_summary', { p_as_at: asAt });
  if (error) throw error;
  return data as NeverBilledSummary;
}

export function useNeverBilledSummary(asAt: string | null = null) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'neverBilledSummary', asAt],
    queryFn: () => fetchNeverBilledSummary(asAt),
    staleTime: 60_000,
  });
}
