import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { BreadcrumbPath } from './useLocationBreakdown';

export interface LocationSearchHit {
  kind: 'country' | 'region' | 'district' | 'ward' | 'agent' | 'landlord';
  label: string;
  country: string | null;
  region: string | null;
  district: string | null;
  ward: string | null;
  agent_id: string | null;
  landlord_id: string | null;
  total: number;
  district_id?: number | null;
  subcounty_id?: number | null;
}

export function hitToPath(hit: LocationSearchHit): BreadcrumbPath {
  const path: BreadcrumbPath = {};
  if (hit.country) path.country = hit.country;
  if (hit.region) path.region = hit.region;
  if (hit.district) path.district = hit.district;
  if (hit.ward) path.ward = hit.ward;
  if (hit.district_id != null) path.districtId = hit.district_id;
  if (hit.subcounty_id != null) path.subcountyId = hit.subcounty_id;
  if (hit.agent_id) { path.agentId = hit.agent_id; path.agentName = hit.label; }
  if (hit.landlord_id) { path.landlordId = hit.landlord_id; path.landlordName = hit.label; }
  return path;
}

export function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useLocationSearch(query: string) {
  const debounced = useDebounced(query.trim(), 250);
  return useQuery({
    enabled: debounced.length >= 2,
    queryKey: ['location-search', debounced],
    staleTime: 30 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('search_locations' as any, { p_query: debounced, p_limit: 25 });
      if (error) throw error;
      return (data ?? []) as LocationSearchHit[];
    },
  });
}