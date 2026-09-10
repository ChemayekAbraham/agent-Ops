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
  agents: 'tenant-location-correction-agents',
  dashboard: 'tenant-location-correction-dashboard',
} as const;

/** Progressive login-popup requirement: 60% of what is listed, or everything when 5 or fewer remain. */
export const CORRECTION_GATE_RATIO = 0.6;
export const CORRECTION_GATE_SMALL_BATCH = 5;
export function requiredCorrections(listed: number) {
  if (listed <= 0) return 0;
  if (listed <= CORRECTION_GATE_SMALL_BATCH) return listed;
  return Math.ceil(listed * CORRECTION_GATE_RATIO);
}

export interface TenantLocationDashboardAgent {
  agent_id: string;
  agent_name: string | null;
  agent_phone: string | null;
  total_tenants: number;
  outstanding: number;
  corrected: number;
  required: number;
  pct: number;
}

export interface TenantLocationDashboardDay {
  day: string;
  corrections: number;
  tenants: number;
  actors: number;
  agents: number;
}

export interface TenantLocationDashboard {
  as_of_day: string;
  total_tenants: number;
  outstanding: number;
  corrected: number;
  required: number;
  corrected_today: number;
  corrected_week: number;
  corrected_month: number;
  agents_outstanding: number;
  agents_completed: number;
  agents_involved: number;
  agents_total: number;
  avg_corrections_per_agent: number;
  top_progress: TenantLocationDashboardAgent[];
  top_outstanding: TenantLocationDashboardAgent[];
  agents: TenantLocationDashboardAgent[];
  daily: TenantLocationDashboardDay[];
}

/** Ops dashboard aggregate — one round trip, optionally scoped to a single agent. */
export function useTenantLocationDashboard(agentId?: string | null, enabled = true) {
  return useQuery({
    queryKey: [TENANT_LOCATION_KEYS.dashboard, agentId ?? 'all'],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<TenantLocationDashboard> => {
      const { data, error } = await supabase.rpc('tenant_location_correction_dashboard', {
        p_agent_id: agentId ?? undefined,
      });
      if (error) throw error;
      return data as unknown as TenantLocationDashboard;
    },
  });
}

export interface TenantLocationCorrectionAgent {
  agent_id: string;
  agent_name: string | null;
  agent_phone: string | null;
  total_tenants: number;
  matched: number;
  unmatched: number;
}

/** Agents (incl. sub-agents / senior agents) who still have tenants to correct. */
export function useTenantLocationCorrectionAgents(search = '', enabled = true) {
  return useQuery({
    queryKey: [TENANT_LOCATION_KEYS.agents, search.trim()],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<TenantLocationCorrectionAgent[]> => {
      const { data, error } = await supabase.rpc('tenant_location_correction_agents' as any, {
        p_search: search.trim() || null,
        p_limit: 300,
      });
      if (error) throw error;
      return (data ?? []) as TenantLocationCorrectionAgent[];
    },
  });
}

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
      qc.invalidateQueries({ queryKey: [TENANT_LOCATION_KEYS.agents] });
      qc.invalidateQueries({ queryKey: [TENANT_LOCATION_KEYS.dashboard] });
      qc.invalidateQueries({ queryKey: ['tenant-location-active-metrics'] });
    },
  });
}

/**
 * Active-tenant location metrics for the Tenant Ops corrections page.
 *
 * Reuses the system's existing definition of an active rent relationship —
 * a rent request in `funded`, `disbursed` or `repaying` (the same status set
 * used by Agent Monitoring and agent exposure) — and the same tenant
 * population and official-village match rule as the corrections dashboard.
 * Read-only: `tenant_location_correction_active_metrics(p_agent_id)`.
 */
export interface TenantLocationActiveMetrics {
  total_tenants: number;
  active_tenants: number;
  active_corrected: number;
  active_outstanding: number;
  total_outstanding: number;
  active_pct_corrected: number;
  active_share_of_population: number;
  active_share_of_outstanding: number;
}

export function useTenantLocationActiveMetrics(agentId?: string | null, enabled = true) {
  return useQuery({
    queryKey: ['tenant-location-active-metrics', agentId ?? 'all'],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<TenantLocationActiveMetrics> => {
      const { data, error } = await supabase.rpc('tenant_location_correction_active_metrics' as any, {
        p_agent_id: agentId ?? null,
      });
      if (error) throw error;
      return (data ?? {}) as unknown as TenantLocationActiveMetrics;
    },
  });
}
