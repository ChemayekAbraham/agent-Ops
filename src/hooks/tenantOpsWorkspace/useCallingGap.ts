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

export interface CallingGapSummary {
  tenant_count: number;
  total_arrears_ugx: number;
  basis: string;
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

async function fetchCallingGapSummary(): Promise<CallingGapSummary> {
  const { data, error } = await anyDb.rpc('tops_calling_gap_summary');
  if (error) throw error;
  return data as CallingGapSummary;
}

/** The panel's total arrears figure — server-computed, never summed from the row list in the browser. */
export function useCallingGapSummary() {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'callingGapSummary'],
    queryFn: fetchCallingGapSummary,
    staleTime: 60_000,
  });
}
