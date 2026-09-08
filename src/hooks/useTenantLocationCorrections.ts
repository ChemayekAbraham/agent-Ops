/**
 * Legacy tenant location correction — data layer.
 *
 * A tenant is "unmatched" when their profile has no official village id from the
 * approved Uganda dataset (ug_districts → ug_counties → ug_subcounties →
 * ug_parishes → ug_villages). Tenants registered with the picker already carry
 * that id and therefore never appear here.
 *
 * All reads and the single write go through SECURITY DEFINER RPCs:
 *  - tenant_location_corrections(p_agent_id, p_search, p_limit, p_offset)
 *  - tenant_location_correction_progress(p_agent_id)
 *  - correct_tenant_location(p_tenant_id, p_village_id, p_reason)  ← location only
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface TenantLocationCorrectionRow {
  tenant_id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
  legacy_region: string | null;
  legacy_district: string | null;
  legacy_sub_county: string | null;
  legacy_parish: string | null;
  legacy_village: string | null;
  monthly_rent: number | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_phone: string | null;
  request_status: string | null;
  requested_at: string | null;
  total_count: number;
}

export interface TenantLocationProgress {
  total_tenants: number;
  matched: number;
  unmatched: number;
}

/** Human label for the old typed address, used as read-only context. */
export function legacyLocationLabel(row: TenantLocationCorrectionRow) {
  const parts = [row.legacy_village, row.legacy_parish, row.legacy_sub_county, row.legacy_district, row.legacy_region]
    .map((v) => (v ?? '').trim())
    .filter(Boolean);
  return parts.length ? parts.join(', ') : 'No location on record';
}

export const TENANT_LOCATION_KEYS = {
  list: 'tenant-location-corrections',
  progress: 'tenant-location-correction-progress',
} as const;

export function useTenantLocationProgress(agentId?: string | null, enabled = true) {
  return useQuery({
    queryKey: [TENANT_LOCATION_KEYS.progress, agentId ?? 'all'],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<TenantLocationProgress> => {
      const { data, error } = await supabase.rpc('tenant_location_correction_progress' as any, {
        p_agent_id: agentId ?? null,
      });
      if (error) throw error;
      const row = (data as TenantLocationProgress[] | null)?.[0];
      return row ?? { total_tenants: 0, matched: 0, unmatched: 0 };
    },
  });
}

export function useTenantLocationCorrections(opts: {
  agentId?: string | null;
  search?: string;
  page?: number;
  pageSize?: number;
  enabled?: boolean;
}) {
  const { agentId = null, search = '', page = 0, pageSize = 50, enabled = true } = opts;
  return useQuery({
    queryKey: [TENANT_LOCATION_KEYS.list, agentId ?? 'all', search.trim(), page, pageSize],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('tenant_location_corrections' as any, {
        p_agent_id: agentId,
        p_search: search.trim() || null,
        p_limit: pageSize,
        p_offset: page * pageSize,
      });
      if (error) throw error;
      const rows = (data ?? []) as TenantLocationCorrectionRow[];
      return { rows, total: rows[0]?.total_count ?? 0 };
    },
  });
}

export function useCorrectTenantLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { tenantId: string; villageId: number; reason?: string }) => {
      const { data, error } = await supabase.rpc('correct_tenant_location' as any, {
        p_tenant_id: vars.tenantId,
        p_village_id: vars.villageId,
        p_reason: vars.reason ?? 'Legacy location corrected to the approved Uganda location dataset',
      });
      if (error) throw error;
      return data as { success: boolean; full_path?: string };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [TENANT_LOCATION_KEYS.list] });
      qc.invalidateQueries({ queryKey: [TENANT_LOCATION_KEYS.progress] });
    },
  });
}
