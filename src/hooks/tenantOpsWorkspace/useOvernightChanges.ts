/** Reads tops_overnight_changes() — rolled into arrears, promises broken (placeholder), plans completed. */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface OvernightChangeItem {
  rent_request_id: string;
  tenant_name: string | null;
  agent_name?: string | null;
  arrears_ugx?: number;
  total_repayment_ugx?: number;
}

export interface OvernightChangeGroup {
  count: number;
  total_arrears_ugx?: number;
  total_repayment_ugx?: number;
  items: OvernightChangeItem[];
  items_capped_at?: number;
  note?: string;
}

export interface OvernightChanges {
  as_at: string;
  rolled_into_arrears: OvernightChangeGroup;
  promises_broken: OvernightChangeGroup;
  plans_completed: OvernightChangeGroup;
}

async function fetchOvernightChanges(asAt?: string): Promise<OvernightChanges> {
  const { data, error } = await anyDb.rpc('tops_overnight_changes', { p_as_at: asAt ?? null });
  if (error) throw error;
  return data as OvernightChanges;
}

export function useOvernightChanges(asAt?: string) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'overnightChanges', asAt ?? null],
    queryFn: () => fetchOvernightChanges(asAt),
    staleTime: 60_000,
  });
}
