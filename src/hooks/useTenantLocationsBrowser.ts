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

// ---------------------------------------------------------------------------
// Multi-place selection (read-only). A selected place is one path of the same
// shape the single-place browser already uses; the server returns each tenant
// once, credited to the most specific selected place (tlb_tenants_multi).
// ---------------------------------------------------------------------------

/** Hard cap shared by the server (tlb_tenants_multi) and the PDF export. */
export const TLB_MULTI_MAX_TENANTS = 5000;

export interface TlbSelectedPlace {
  /** Stable key, see tlbPathKey. */
  key: string;
  /** Short name shown on chips and headings (village, district, ...). */
  label: string;
  /** Full path, largest to smallest: Region, District, ... , Village. */
  fullPath: string[];
  path: TlbPath;
}

export interface TlbMultiTenant extends Omit<TlbTenant, 'total_count'> {
  matched_path_index: number;
  total_count: number;
}

/**
 * Stable identity of a place, independent of names and of how it was reached
 * (search hit or drill-down). Same place, same key, so a selection survives new
 * searches and navigation and cannot be added twice.
 */
export function tlbPathKey(path: TlbPath): string {
  if (path.unmapped) return 'unmapped';
  return [
    `r:${path.region ?? ''}`,
    `d:${path.districtId ?? ''}`,
    `c:${path.countyId ?? ''}`,
    `s:${path.subcountyId ?? ''}`,
    `p:${path.parishId ?? ''}`,
    `v:${path.villageId ?? ''}`,
  ].join('|');
}

/** Names of a path that are known, largest to smallest. */
export function pathNames(path: TlbPath): string[] {
  if (path.unmapped) return ['Unmapped'];
  return [
    path.region, path.districtName, path.countyName,
    path.subcountyName, path.parishName, path.villageName,
  ].filter((v): v is string => !!v);
}

/** The path a child row opens, given the list level it was shown at. */
export function childToPath(
  parent: TlbPath,
  level: TlbLevel | null,
  nodeId: number | null,
  label: string,
  unmapped: boolean,
): TlbPath | null {
  if (unmapped) return { unmapped: true };
  switch (level) {
    case 'region':    return { region: label };
    case 'district':  return { ...parent, districtId: nodeId!, districtName: label };
    case 'county':    return { ...parent, countyId: nodeId!, countyName: label };
    case 'subcounty': return { ...parent, subcountyId: nodeId!, subcountyName: label };
    case 'parish':    return { ...parent, parishId: nodeId!, parishName: label };
    case 'village':   return { ...parent, villageId: nodeId!, villageName: label };
    default: return null;
  }
}

export function placeFromPath(path: TlbPath, label?: string): TlbSelectedPlace {
  const names = pathNames(path);
  return {
    key: tlbPathKey(path),
    label: label ?? names[names.length - 1] ?? 'Place',
    fullPath: names,
    path,
  };
}

export function placeFromChild(
  parent: TlbPath,
  level: TlbLevel | null,
  nodeId: number | null,
  label: string,
  unmapped: boolean,
): TlbSelectedPlace | null {
  const path = childToPath(parent, level, nodeId, label, unmapped);
  return path ? placeFromPath(path, unmapped ? 'Unmapped' : label) : null;
}

/** A search hit knows its parents only as text ("parish, sub-county, district"). */
export function placeFromHit(hit: TlbLocationHit): TlbSelectedPlace {
  const parents = (hit.kind === 'district' ? [] : (hit.path_label ?? '').split(', ').reverse())
    .map((v) => v.trim()).filter(Boolean);
  const fullPath = [hit.region, ...parents, hit.label]
    .filter((v): v is string => !!v)
    .filter((v, i, all) => i === 0 || v !== all[i - 1]);
  const path = hitToPath(hit);
  return { key: tlbPathKey(path), label: hit.label, fullPath, path };
}

/** Argument shape of tlb_tenants_multi.p_paths, in selection order. */
export function toRpcPaths(places: readonly TlbSelectedPlace[]) {
  return places.map(({ path }) => ({
    region: path.region ?? null,
    district_id: path.districtId ?? null,
    county_id: path.countyId ?? null,
    subcounty_id: path.subcountyId ?? null,
    parish_id: path.parishId ?? null,
    village_id: path.villageId ?? null,
    unmapped: !!path.unmapped,
  }));
}

export interface TlbMultiResult {
  rows: TlbMultiTenant[];
  /** Distinct tenants across all selected places (may exceed rows.length). */
  total: number;
}

export async function fetchTlbTenantsMulti(
  places: readonly TlbSelectedPlace[],
  status: TlbStatus,
  limit = TLB_MULTI_MAX_TENANTS,
): Promise<TlbMultiResult> {
  const { data, error } = await supabase.rpc('tlb_tenants_multi' as any, {
    p_paths: toRpcPaths(places),
    p_status: status,
    p_limit: limit,
  });
  if (error) throw error;
  const rows = ((data ?? []) as TlbMultiTenant[]).map((r) => ({
    ...r,
    matched_path_index: Number(r.matched_path_index),
    total_count: Number(r.total_count),
  }));
  return { rows, total: rows[0]?.total_count ?? 0 };
}

export function useTlbTenantsMulti(
  places: readonly TlbSelectedPlace[],
  status: TlbStatus,
  enabled = true,
) {
  const keys = places.map((p) => p.key);
  return useQuery({
    enabled: enabled && places.length > 0,
    queryKey: ['tlb-tenants-multi', keys, status],
    staleTime: 30_000,
    queryFn: () => fetchTlbTenantsMulti(places, status),
  });
}

/**
 * Append-only audit row for a Tenant Location Report PDF (it carries personal
 * phone numbers). Caller-checked on the server; the reason is always >= 10 chars.
 */
export async function logTlbLocationPdfExport(args: {
  places: readonly TlbSelectedPlace[];
  tenants: number;
  status: TlbStatus;
}): Promise<void> {
  const reason = `Tenant Location Report PDF: ${args.places.length} places, ${args.tenants} tenants, status ${args.status}`;
  const { error } = await supabase.rpc('tlb_log_location_pdf_export' as any, {
    p_reason: reason,
    p_places: args.places.length,
    p_tenants: args.tenants,
    p_status: args.status,
    p_place_labels: args.places.slice(0, 25).map((p) => p.fullPath.join(' > ')),
  });
  if (error) throw error;
}
