/** Reads tops_unmapped_tenants_worklist(p_limit) — a finite, oldest-first worklist. */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface UnmappedTenantRow {
  rent_request_id: string;
  tenant_id: string;
  tenant_name: string | null;
  agent_id: string | null;
  agent_name: string | null;
  legacy_location: string | null;
}

async function fetchUnmappedTenantsWorklist(limit: number): Promise<UnmappedTenantRow[]> {
  const { data, error } = await anyDb.rpc('tops_unmapped_tenants_worklist', { p_limit: limit });
  if (error) throw error;
  return (data ?? []) as UnmappedTenantRow[];
}

export function useUnmappedTenantsWorklist(limit = 200) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'unmappedTenantsWorklist', limit],
    queryFn: () => fetchUnmappedTenantsWorklist(limit),
    staleTime: 60_000,
  });
}
