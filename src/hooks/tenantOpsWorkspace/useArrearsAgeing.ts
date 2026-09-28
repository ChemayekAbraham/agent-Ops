/** Reads tops_arrears_ageing() — bucketed 1-7/8-14/15-30/30+, server-paginated, server-sorted. */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export type ArrearsBucket = '1-7' | '8-14' | '15-30' | '30+';

export interface ArrearsRow {
  rent_request_id: string;
  tenant_name: string | null;
  agent_name: string | null;
  arrears_ugx: number;
  oldest_due_date: string;
  age_days: number;
  bucket: ArrearsBucket;
}

export interface ArrearsAgeingResult {
  as_at: string;
  summary: Partial<Record<ArrearsBucket, { count: number; arrears_ugx: number }>>;
  total_row_count: number;
  rows: ArrearsRow[];
}

export interface ArrearsAgeingParams {
  asAt?: string;
  bucket?: ArrearsBucket | null;
  limit?: number;
  offset?: number;
  dir?: 'asc' | 'desc';
}

async function fetchArrearsAgeing(params: ArrearsAgeingParams): Promise<ArrearsAgeingResult> {
  const { data, error } = await anyDb.rpc('tops_arrears_ageing', {
    p_as_at: params.asAt ?? null,
    p_bucket: params.bucket ?? null,
    p_limit: params.limit ?? 50,
    p_offset: params.offset ?? 0,
    p_dir: params.dir ?? 'desc',
  });
  if (error) throw error;
  return data as ArrearsAgeingResult;
}

export function useArrearsAgeing(params: ArrearsAgeingParams) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'arrearsAgeing', params],
    queryFn: () => fetchArrearsAgeing(params),
    staleTime: 30_000,
  });
}
