import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { PUBLIC_HOUSE_LISTING_COLUMNS } from '@/lib/houseListingColumns';

export type DemoRentalCardId = 'r1' | 'r2' | 'r3';

/**
 * Resolves the three demo rent-discount carousel cards to real available
 * `house_listings` rows so tapping a card can deep-link to `/house/:id`.
 * Returns null for any card that has no matching available listing — the
 * caller should fall back to the generic Available Houses sheet.
 */
export function useDemoRentalTargets() {
  return useQuery({
    queryKey: ['demo-rental-targets', 'v1'],
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    queryFn: async (): Promise<Record<DemoRentalCardId, string | null>> => {
      const { data, error } = await supabase
        .from('house_listings')
        .select(PUBLIC_HOUSE_LISTING_COLUMNS)
        .eq('status', 'available')
        .eq('is_hidden', false)
        .limit(500);
      if (error) throw error;
      const rows = (data ?? []) as Array<{
        id: string;
        district: string | null;
        sub_county: string | null;
      }>;

      const pick = (predicate: (r: (typeof rows)[number]) => boolean, fallback?: (r: (typeof rows)[number]) => boolean) => {
        const primary = rows.find(predicate);
        if (primary) return primary.id;
        if (fallback) {
          const alt = rows.find(fallback);
          if (alt) return alt.id;
        }
        return null;
      };

      const isKampala = (r: { district: string | null }) =>
        (r.district ?? '').toLowerCase().includes('kampala');

      return {
        // Modern Apartments → Ntinda / Kampala
        r1: pick(
          (r) => (r.sub_county ?? '').toLowerCase().includes('ntinda'),
          (r) => isKampala(r),
        ),
        // Family House → Kabale
        r2: pick(
          (r) => (r.district ?? '').toLowerCase().includes('kabale'),
          (r) => !isKampala(r),
        ),
        // City Studio → Bukoto / Kampala
        r3: pick(
          (r) => (r.sub_county ?? '').toLowerCase().includes('bukoto'),
          (r) => isKampala(r),
        ),
      };
    },
  });
}