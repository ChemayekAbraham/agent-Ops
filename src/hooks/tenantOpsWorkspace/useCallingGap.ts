/** Reads tops_calling_gap() — eligible tenants with no row in the currently-open cc_ round. Read-only; the round itself is untouched. */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface CallingGapRow {
  tenant_id: string;
  rent_request_id: string | null;
  outstanding: number | null;
  arrears_amount: number | null;
}

async function fetchCallingGap(): Promise<CallingGapRow[]> {
  const { data, error } = await anyDb.rpc('tops_calling_gap');
  if (error) throw error;
  return (data ?? []) as CallingGapRow[];
}

export function useCallingGap() {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'callingGap'],
    queryFn: fetchCallingGap,
    staleTime: 60_000,
  });
}
