import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

type Table = 'house_listings' | 'landlords' | 'lc1_chairpersons';

export type ServiceCentreComment = {
  comment: string | null;
  reviewed_at: string | null;
};

/**
 * Fetches Service Centre vetting comments for the currently visible rows.
 * Kept as a side lookup so the heavy ops RPCs keep their existing shapes.
 */
export function useServiceCentreComments(table: Table, ids: string[]) {
  const key = [...new Set(ids.filter(Boolean))].sort();
  return useQuery({
    queryKey: ['service-centre-comments', table, key],
    enabled: key.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const map: Record<string, ServiceCentreComment> = {};
      const CHUNK = 200;
      for (let i = 0; i < key.length; i += CHUNK) {
        const { data, error } = await supabase
          .from(table)
          .select('id, service_center_comment, service_center_reviewed_at')
          .in('id', key.slice(i, i + CHUNK));
        if (error) throw error;
        for (const row of data ?? []) {
          map[(row as any).id] = {
            comment: (row as any).service_center_comment ?? null,
            reviewed_at: (row as any).service_center_reviewed_at ?? null,
          };
        }
      }
      return map;
    },
  });
}
