import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Read-only 12-month rent projection data for Tenant Ops → Tenant Products & Services.
 * All figures come from the server-side RPCs (`tpsp_projection`, `tpsp_projection_rows`,
 * `tpsp_projection_filters`). Nothing here writes or derives money client-side.
 */

export type TpspGrain = 'month' | 'quarter' | 'year';

export interface TpspFilters {
  region: string | null;
  districtId: number | null;
  countyId: number | null;
  subcountyId: number | null;
  parishId: number | null;
  villageId: number | null;
  agentId: string | null;
  landlordId: string | null;
  houseId: string | null;
  unmapped: boolean | null;
  search: string;
}

export const emptyTpspFilters: TpspFilters = {
  region: null,
  districtId: null,
  countyId: null,
  subcountyId: null,
  parishId: null,
  villageId: null,
  agentId: null,
  landlordId: null,
  houseId: null,
  unmapped: null,
  search: '',
};

export interface TpspSummary {
  plans: number;
  tenants: number;
  landlords: number;
  houses: number;
  agents: number;
  unmapped_plans: number;
  monthly_tenant_rent: number;
  monthly_landlord_cost: number;
  monthly_margin: number;
  horizon_tenant_rent: number;
  horizon_landlord_cost: number;
  horizon_margin: number;
}

export interface TpspSeriesPoint {
  period_start: string;
  label: string;
  tenant_rent: number;
  landlord_cost: number;
  margin: number;
}

export interface TpspBreakdownRow {
  level: string;
  label: string;
  plans: number;
  monthly_tenant_rent: number;
  monthly_landlord_cost: number;
  monthly_margin: number;
}

export interface TpspProjection {
  grain: TpspGrain;
  months: number;
  start_month: string;
  timezone: string;
  basis: string;
  summary: TpspSummary;
  series: TpspSeriesPoint[];
  breakdown: TpspBreakdownRow[];
}

export interface TpspDetailRow {
  plan_id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_phone: string | null;
  agent_id: string | null;
  agent_name: string | null;
  landlord_id: string | null;
  landlord_name: string | null;
  house_id: string | null;
  house_label: string | null;
  location_label: string | null;
  unmapped: boolean;
  plan_status: string;
  cycle_end_date: string | null;
  monthly_tenant_rent: number;
  monthly_landlord_cost: number;
  monthly_margin: number;
  horizon_tenant_rent: number;
  horizon_margin: number;
  total_count: number;
}

export interface TpspOption {
  value: string | number;
  label: string;
  plans: number;
}

export interface TpspFilterOptions {
  regions: TpspOption[];
  districts: TpspOption[];
  counties: TpspOption[];
  subcounties: TpspOption[];
  parishes: TpspOption[];
  villages: TpspOption[];
  agents: TpspOption[];
  landlords: TpspOption[];
  houses: TpspOption[];
  unmapped_plans: number;
}

const locationArgs = (f: TpspFilters) => ({
  p_region: f.region,
  p_district_id: f.districtId,
  p_county_id: f.countyId,
  p_subcounty_id: f.subcountyId,
  p_parish_id: f.parishId,
  p_village_id: f.villageId,
  p_agent_id: f.agentId,
  p_landlord_id: f.landlordId,
  p_unmapped: f.unmapped,
});

const keyOf = (f: TpspFilters) => [
  f.region, f.districtId, f.countyId, f.subcountyId, f.parishId, f.villageId,
  f.agentId, f.landlordId, f.houseId, f.unmapped, f.search.trim(),
];

export function useTpspProjection(filters: TpspFilters, grain: TpspGrain, months = 12) {
  return useQuery({
    queryKey: ['tpsp-projection', grain, months, ...keyOf(filters)],
    staleTime: 60_000,
    queryFn: async (): Promise<TpspProjection> => {
      const { data, error } = await supabase.rpc('tpsp_projection', {
        p_grain: grain,
        p_months: months,
        p_house_id: filters.houseId,
        p_search: filters.search.trim() || null,
        ...locationArgs(filters),
      });
      if (error) throw error;
      return data as unknown as TpspProjection;
    },
  });
}

export function useTpspProjectionFilters(filters: TpspFilters) {
  return useQuery({
    queryKey: ['tpsp-projection-filters', ...keyOf(filters).slice(0, 10)],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<TpspFilterOptions> => {
      const { data, error } = await supabase.rpc('tpsp_projection_filters', locationArgs(filters));
      if (error) throw error;
      return data as unknown as TpspFilterOptions;
    },
  });
}

/**
 * One-off read of the filtered plan detail (used by the PDF export, which needs
 * every matching plan rather than the visible page). Same RPC, larger window.
 */
export async function fetchTpspProjectionRows(
  filters: TpspFilters,
  months: number,
  limit: number,
): Promise<{ rows: TpspDetailRow[]; total: number }> {
  const { data, error } = await supabase.rpc('tpsp_projection_rows', {
    p_months: months,
    p_house_id: filters.houseId,
    p_search: filters.search.trim() || null,
    p_limit: limit,
    p_offset: 0,
    ...locationArgs(filters),
  });
  if (error) throw error;
  const rows = (data ?? []) as unknown as TpspDetailRow[];
  return { rows, total: Number(rows[0]?.total_count ?? 0) };
}

export function useTpspProjectionRows(
  filters: TpspFilters,
  months: number,
  page: number,
  pageSize: number,
  enabled = true,
) {
  return useQuery({
    queryKey: ['tpsp-projection-rows', months, page, pageSize, ...keyOf(filters)],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<{ rows: TpspDetailRow[]; total: number }> => {
      const { data, error } = await supabase.rpc('tpsp_projection_rows', {
        p_months: months,
        p_house_id: filters.houseId,
        p_search: filters.search.trim() || null,
        p_limit: pageSize,
        p_offset: page * pageSize,
        ...locationArgs(filters),
      });
      if (error) throw error;
      const rows = (data ?? []) as unknown as TpspDetailRow[];
      return { rows, total: Number(rows[0]?.total_count ?? 0) };
    },
  });
}
