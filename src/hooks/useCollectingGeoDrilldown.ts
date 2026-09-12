/**
 * Read-only geographic drilldown for the "landlord float being collected" panel.
 *
 * Country -> Region -> District -> County -> Sub-county -> Parish -> Village/Cell -> House.
 * Every figure comes from the SECURITY DEFINER RPC
 * `landlord_ops_collecting_geo_page(...)`; nothing is recomputed here and
 * nothing is written. Recorded location text is never rewritten — spellings that
 * match no approved place are grouped as "Unmapped" and shown as recorded.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

type RpcFn = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;

export const COLLECTING_GEO_LEVELS = [
  'country',
  'region',
  'district',
  'county',
  'subcounty',
  'parish',
  'village',
  'houses',
] as const;

export type CollectingGeoLevel = (typeof COLLECTING_GEO_LEVELS)[number];

export const COLLECTING_GEO_LEVEL_LABELS: Record<CollectingGeoLevel, string> = {
  country: 'Country',
  region: 'Region',
  district: 'District',
  county: 'County',
  subcounty: 'Sub-county',
  parish: 'Parish',
  village: 'Village / Cell',
  houses: 'Houses',
};

export interface CollectingGeoPath {
  country?: string | null;
  region?: string | null;
  district?: string | null;
  county?: string | null;
  subcounty?: string | null;
  parish?: string | null;
  village?: string | null;
}

export interface CollectingGeoGroupRow {
  label: string;
  plans: number;
  houses: number;
  contracted: number;
  collected: number;
  outstanding: number;
  daily_repayment: number;
  unmatched: boolean;
}

export interface CollectingGeoHouseRow {
  rent_request_id: string;
  house_listing_id: string | null;
  house_title: string | null;
  house_address: string | null;
  house_image_url: string | null;
  latitude: number | null;
  longitude: number | null;
  country: string;
  region: string;
  district: string;
  county: string;
  subcounty: string;
  parish: string;
  village: string;
  geo_official: boolean;
  landlord_id: string | null;
  landlord_name: string;
  landlord_phone: string | null;
  mobile_money_name: string | null;
  mobile_money_number: string | null;
  caretaker_name: string | null;
  caretaker_phone: string | null;
  lc1_chairperson_name: string | null;
  lc1_chairperson_phone: string | null;
  tenant_id: string | null;
  tenant_name: string;
  tenant_phone: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_phone: string | null;
  status: string;
  funded_at: string | null;
  rent_amount: number;
  contracted: number;
  collected: number;
  outstanding: number;
  daily_repayment: number;
}

export interface CollectingGeoTotals {
  plans: number;
  houses: number;
  contracted: number;
  collected: number;
  outstanding: number;
  daily_repayment: number;
}

export interface CollectingGeoPage {
  as_at: string;
  level: CollectingGeoLevel;
  rows: CollectingGeoGroupRow[] | CollectingGeoHouseRow[];
  total_rows: number;
  totals: CollectingGeoTotals;
}

/** The next level to open after the given path (houses is the leaf). */
export function nextCollectingLevel(path: CollectingGeoPath): CollectingGeoLevel {
  if (!path.country) return 'country';
  if (!path.region) return 'region';
  if (!path.district) return 'district';
  if (!path.county) return 'county';
  if (!path.subcounty) return 'subcounty';
  if (!path.parish) return 'parish';
  if (!path.village) return 'village';
  return 'houses';
}

/** Path key that a chosen row at `level` fills in. */
export function collectingPathKeyFor(level: CollectingGeoLevel): keyof CollectingGeoPath | null {
  switch (level) {
    case 'country':
      return 'country';
    case 'region':
      return 'region';
    case 'district':
      return 'district';
    case 'county':
      return 'county';
    case 'subcounty':
      return 'subcounty';
    case 'parish':
      return 'parish';
    case 'village':
      return 'village';
    default:
      return null;
  }
}

export interface CollectingGeoSuggestion extends CollectingGeoPath {
  kind: 'place' | 'house';
  level: CollectingGeoLevel;
  label: string;
  plans: number;
  outstanding: number;
  detail: string | null;
}

/** Optional collection period (Kampala-local dates, inclusive). */
export interface CollectingGeoPeriod {
  from?: string | null;
  to?: string | null;
}

export function useCollectingGeoPage(
  path: CollectingGeoPath,
  opts: {
    search?: string;
    limit?: number;
    offset?: number;
    enabled?: boolean;
    period?: CollectingGeoPeriod;
  } = {},
) {
  const level = nextCollectingLevel(path);
  const { search = '', limit = 25, offset = 0, enabled = true, period } = opts;
  const q = search.trim() || null;
  const from = period?.from || null;
  const to = period?.to || null;

  return useQuery({
    queryKey: ['landlord-collecting-geo', level, path, q, limit, offset, from, to],
    enabled,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<CollectingGeoPage> => {
      const { data, error } = await (supabase.rpc as unknown as RpcFn)(
        'landlord_ops_collecting_geo_page',
        {
          p_level: level,
          p_country: path.country ?? null,
          p_region: path.region ?? null,
          p_district: path.district ?? null,
          p_county: path.county ?? null,
          p_subcounty: path.subcounty ?? null,
          p_parish: path.parish ?? null,
          p_village: path.village ?? null,
          p_search: q,
          p_limit: limit,
          p_offset: offset,
          p_from: from,
          p_to: to,
        },
      );
      if (error) throw error;
      return data as CollectingGeoPage;
    },
  });
}

/**
 * Autocomplete suggestions for the location search box: countries, regions,
 * districts, counties, sub-counties, parishes, villages plus house / landlord /
 * tenant / agent matches. Read-only.
 */
export function useCollectingGeoSuggestions(search: string, period?: CollectingGeoPeriod) {
  const q = search.trim();
  const from = period?.from || null;
  const to = period?.to || null;

  return useQuery({
    queryKey: ['landlord-collecting-geo-suggest', q, from, to],
    enabled: q.length >= 2,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<CollectingGeoSuggestion[]> => {
      const { data, error } = await (supabase.rpc as unknown as RpcFn)(
        'landlord_ops_collecting_geo_suggest',
        { p_search: q, p_limit: 12, p_from: from, p_to: to },
      );
      if (error) throw error;
      const rows = (data as { suggestions?: CollectingGeoSuggestion[] } | null)?.suggestions ?? [];
      return rows;
    },
  });
}
