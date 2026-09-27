/** Reads tops_never_billed() — arrears for due dates absent from the pinned bill, server-paginated. */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface NeverBilledRow {
  rent_request_id: string;
  tenant_name: string | null;
  agent_name: string | null;
  never_billed_arrears_ugx: number;
  earliest_due_date: string;
}

export interface NeverBilledResult {
  as_at: string;
  summary: { count: number; arrears_ugx: number };
  explanation: string;
  total_row_count: number;
  rows: NeverBilledRow[];
}

export interface NeverBilledParams {
  asAt?: string;
  limit?: number;
  offset?: number;
  dir?: 'asc' | 'desc';
}

async function fetchNeverBilled(params: NeverBilledParams): Promise<NeverBilledResult> {
  const { data, error } = await anyDb.rpc('tops_never_billed', {
    p_as_at: params.asAt ?? null,
    p_limit: params.limit ?? 50,
    p_offset: params.offset ?? 0,
    p_dir: params.dir ?? 'desc',
  });
  if (error) throw error;
  return data as NeverBilledResult;
}

export function useNeverBilled(params: NeverBilledParams) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'neverBilled', params],
    queryFn: () => fetchNeverBilled(params),
    staleTime: 30_000,
  });
}
