/**
 * Read-only data layer for the parallel "Tenant Locations" test page.
 *
 * Everything here is server-side (tlb_* RPCs over v_tlb_tenant_base). No tenant,
 * agent, rent-request or location value is ever written, normalised or guessed:
 * a tenant is placed by its existing official ids (ug_village_id chain, else
 * profiles.district_id) and otherwise stays under Unmapped with its legacy text.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type TlbLevel = 'region' | 'district' | 'county' | 'subcounty' | 'parish' | 'village';
export type TlbStatus = 'all' | 'active' | 'inactive';

export interface TlbPath {
  region?: string;
  districtId?: number;
  districtName?: string;
  countyId?: number;
  countyName?: string;
  subcountyId?: number;
  subcountyName?: string;
  parishId?: number;
  parishName?: string;
  villageId?: number;
  villageName?: string;
  unmapped?: boolean;
}

export interface TlbChild {
  node_id: number | null;
  label: string;
  tenant_count: number;
  leaf_count: number;
  unmapped: boolean;
}

export interface TlbTenant {
  tenant_id: string;
  tenant_name: string;
  tenant_phone: string | null;
  agent_id: string | null;
  agent_name: string | null;
  latest_status: string | null;
  is_active: boolean;
  depth: number;
  region: string | null;
  district_name: string | null;
  county_name: string | null;
  subcounty_name: string | null;
  parish_name: string | null;
  village_name: string | null;
  legacy_location: string | null;
  total_count: number;
}

export interface TlbLocationHit {
  kind: 'district' | 'subcounty' | 'village';
  label: string;
  path_label: string | null;
  region: string | null;
  district_id: number | null;
  county_id: number | null;
  subcounty_id: number | null;
  parish_id: number | null;
  village_id: number | null;
  tenant_count: number;
}

/** The level whose children should be listed for the given path. */
export function childLevelFor(path: TlbPath): TlbLevel | null {
  if (path.unmapped) return null;
  if (!path.region) return 'region';
  if (!path.districtId) return 'district';
  if (!path.countyId) return 'county';
  if (!path.subcountyId) return 'subcounty';
  if (!path.parishId) return 'parish';
  if (!path.villageId) return 'village';
  return null;
}

const parents = (path: TlbPath) => ({
  p_region: path.region ?? null,
  p_district_id: path.districtId ?? null,
  p_county_id: path.countyId ?? null,
  p_subcounty_id: path.subcountyId ?? null,
  p_parish_id: path.parishId ?? null,
});

export function useTlbChildren(path: TlbPath, status: TlbStatus, search: string) {
  const level = childLevelFor(path);
  return useQuery({
    enabled: !!level,
    queryKey: ['tlb-children', level, path, status, search],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('tlb_children' as any, {
        p_level: level,
        ...parents(path),
        p_status: status,
        p_search: search || null,
      });
      if (error) throw error;
      return (data ?? []) as TlbChild[];
    },
  });
}

/**
 * Tenants for the current node. `atLevel='district'` returns only the tenants
 * whose approved location stops at district level — they are never pushed into
 * a county/village they do not have.
 */
export function useTlbTenants(
  path: TlbPath,
  status: TlbStatus,
  search: string,
  page: number,
  pageSize = 50,
  atLevel: 'district' | null = null,
  enabled = true,
) {
  return useQuery({
    enabled,
    queryKey: ['tlb-tenants', path, status, search, page, pageSize, atLevel],
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('tlb_tenants' as any, {
        ...parents(path),
        p_village_id: path.villageId ?? null,
        p_unmapped: !!path.unmapped,
        p_at_level: atLevel,
        p_status: status,
        p_search: search || null,
        p_limit: pageSize,
        p_offset: (page - 1) * pageSize,
      });
      if (error) throw error;
      const rows = (data ?? []) as TlbTenant[];
      return { rows, total: rows[0]?.total_count ?? 0 };
    },
  });
}

export function useTlbLocationSearch(query: string, status: TlbStatus) {
  const term = query.trim();
  return useQuery({
    enabled: term.length >= 2,
    queryKey: ['tlb-location-search', term, status],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('tlb_search_locations' as any, {
        p_query: term,
        p_status: status,
        p_limit: 25,
      });
      if (error) throw error;
      return (data ?? []) as TlbLocationHit[];
    },
  });
}

export function hitToPath(hit: TlbLocationHit): TlbPath {
  return {
    region: hit.region ?? undefined,
    districtId: hit.district_id ?? undefined,
    districtName: hit.kind === 'district' ? hit.label : undefined,
    countyId: hit.county_id ?? undefined,
    subcountyId: hit.subcounty_id ?? undefined,
    subcountyName: hit.kind === 'subcounty' ? hit.label : undefined,
    parishId: hit.parish_id ?? undefined,
    villageId: hit.village_id ?? undefined,
    villageName: hit.kind === 'village' ? hit.label : undefined,
  };
}
