/**
 * Filter options for the house browsing surfaces, derived from the LISTINGS
 * THEMSELVES (not from a hardcoded list). One RPC returns every region,
 * district, sub-county, village and property type that actually has a
 * browsable house (available, not hidden, has a real photo) plus a live count,
 * scoped by the shopper's current region / district / sub-county pick.
 *
 * Area names are validated against Uganda's official ug_* dataset inside the
 * RPC, so typos in legacy free-text listings never become filter options.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface HouseFilterOption {
  value: string;
  count: number;
}

export interface HouseFilterOptions {
  regions: HouseFilterOption[];
  districts: HouseFilterOption[];
  subCounties: HouseFilterOption[];
  villages: HouseFilterOption[];
  categories: HouseFilterOption[];
}

const EMPTY: HouseFilterOptions = { regions: [], districts: [], subCounties: [], villages: [], categories: [] };

export function useHouseFilterOptions(
  scope: { region?: string | null; district?: string | null; subCounty?: string | null } = {},
  enabled = true,
) {
  const region = scope.region && scope.region !== 'all' ? scope.region : null;
  const district = scope.district && scope.district !== 'all' ? scope.district : null;
  const subCounty = scope.subCounty && scope.subCounty !== 'all' ? scope.subCounty : null;

  const query = useQuery({
    queryKey: ['house-filter-options', region, district, subCounty],
    enabled,
    // Listing inventory shifts slowly; a few minutes of cache keeps the sheet instant.
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<HouseFilterOptions> => {
      const { data, error } = await supabase.rpc('get_house_listing_filter_options' as any, {
        p_region: region,
        p_district: district,
        p_subcounty: subCounty,
      });
      if (error) throw error;
      const rows = (data ?? []) as { kind: string; value: string; n: number }[];
      const pick = (kind: string) =>
        rows
          .filter(r => r.kind === kind && (r.value ?? '').trim().length > 0)
          .map(r => ({ value: r.value.trim(), count: Number(r.n) || 0 }))
          .sort((a, b) => a.value.localeCompare(b.value));
      return {
        regions: pick('region'),
        districts: pick('district'),
        subCounties: pick('subcounty'),
        villages: pick('village'),
        categories: pick('category'),
      };
    },
  });

  return { options: query.data ?? EMPTY, loading: query.isLoading, error: query.error };
}
