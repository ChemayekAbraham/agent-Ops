/** Reads tops_collections_movement() — rolled in / recovered / completed between two dates, server-paginated. */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export type MovementType = 'rolled_in' | 'recovered' | 'completed';

export interface MovementRow {
  rent_request_id: string;
  tenant_name: string | null;
  agent_name: string | null;
  movement_type: MovementType;
  amount_ugx: number;
}

export interface MovementResult {
  from: string;
  to: string;
  summary: Partial<Record<MovementType, { count: number; amount_ugx: number }>>;
  total_row_count: number;
  rows: MovementRow[];
}

export interface MovementParams {
  from: string;
  to: string;
  limit?: number;
  offset?: number;
}

async function fetchMovement(params: MovementParams): Promise<MovementResult> {
  const { data, error } = await anyDb.rpc('tops_collections_movement', {
    p_from: params.from,
    p_to: params.to,
    p_limit: params.limit ?? 50,
    p_offset: params.offset ?? 0,
  });
  if (error) throw error;
  return data as MovementResult;
}

export function useCollectionsMovement(params: MovementParams) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'collectionsMovement', params],
    queryFn: () => fetchMovement(params),
    staleTime: 30_000,
  });
}
