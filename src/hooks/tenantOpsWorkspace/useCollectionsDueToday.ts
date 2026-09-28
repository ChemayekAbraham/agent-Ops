/** Reads tops_collections_due_today() — server-paginated, server-sorted. */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface DueTodayRow {
  rent_request_id: string;
  tenant_name: string | null;
  agent_name: string | null;
  expected_ugx: number;
  paid_ugx: number;
  unpaid_ugx: number;
  status: 'paid' | 'partial' | 'unpaid';
}

export interface DueTodayResult {
  as_at: string;
  summary: { billed_ugx: number; paid_ugx: number; unpaid_ugx: number; coverage_pct: number | null };
  total_row_count: number;
  rows: DueTodayRow[];
}

export interface DueTodayParams {
  asAt?: string;
  limit?: number;
  offset?: number;
  sort?: 'expected_ugx' | 'paid_ugx';
  dir?: 'asc' | 'desc';
}

async function fetchDueToday(params: DueTodayParams): Promise<DueTodayResult> {
  const { data, error } = await anyDb.rpc('tops_collections_due_today', {
    p_as_at: params.asAt ?? null,
    p_limit: params.limit ?? 50,
    p_offset: params.offset ?? 0,
    p_sort: params.sort ?? 'expected_ugx',
    p_dir: params.dir ?? 'desc',
  });
  if (error) throw error;
  return data as DueTodayResult;
}

export function useCollectionsDueToday(params: DueTodayParams) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'collectionsDueToday', params],
    queryFn: () => fetchDueToday(params),
    staleTime: 30_000,
  });
}
