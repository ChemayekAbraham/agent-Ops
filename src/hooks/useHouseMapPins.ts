import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Lightweight pin data for the "Find a House" map. Only the columns needed to
 * render price-pill markers + basic popups — no images, descriptions, or
 * landlord data — so the full 6k+ listing set stays under ~250KB.
 */
export interface MapPin {
  id: string;
  title: string;
  house_category: string;
  daily_rate: number;
  latitude: number | null;
  longitude: number | null;
  region: string;
  district: string | null;
  address: string;
  verified: boolean | null;
  image_urls: string[] | null;
}

const MAP_PIN_COLUMNS =
  'id, title, house_category, daily_rate, latitude, longitude, region, district, address, verified, image_urls';

/**
 * Fetches **every listed house** with just the columns the map needs.
 * Enabled only when the map is open — flips off when the user hides it.
 */
export function useHouseMapPins(opts?: {
  region?: string;
  category?: string;
  district?: string;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ['house-map-pins', opts?.region ?? 'all', opts?.category ?? 'all', opts?.district ?? 'all'],
    enabled: opts?.enabled !== false,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<MapPin[]> => {
      let q = supabase
        .from('house_listings')
        .select(MAP_PIN_COLUMNS)
        .order('id');

      if (opts?.region) q = q.eq('region', opts.region);
      if (opts?.category) q = q.eq('house_category', opts.category);
      if (opts?.district) q = q.ilike('district', `${opts.district}%`);

      // Supabase caps rows at 1000 by default. Paginate to get all.
      const all: MapPin[] = [];
      const PAGE = 1000;
      let offset = 0;
      let done = false;

      while (!done) {
        const { data, error } = await q.range(offset, offset + PAGE - 1);
        if (error) throw error;
        const rows = (data ?? []) as unknown as MapPin[];
        all.push(...rows);
        if (rows.length < PAGE) {
          done = true;
        } else {
          offset += PAGE;
        }
      }

      return all;
    },
  });
}
