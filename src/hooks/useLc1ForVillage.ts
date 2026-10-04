/**
 * Resolve the LC1 chairperson already registered for a village.
 *
 * Used by the agent rent-request flow so that once the agent has picked the
 * tenant's official village (via `UgLocationPicker` → `ug_villages`), the LC1
 * step can preselect the chairperson on file for that village instead of making
 * the agent search.
 *
 * Matching order (most precise first):
 *  1. `lc1_chairpersons.ug_village_id` — the dataset-backed link.
 *  2. Case-insensitive village NAME match, narrowed by district when known
 *     (legacy rows registered before `ug_village_id` existed).
 *
 * Verified chairpersons always win over unverified ones.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface Lc1VillageMatch {
  id: string;
  name: string;
  phone: string;
  village: string | null;
  district: string | null;
  region: string | null;
  verified: boolean | null;
  ug_village_id: number | null;
}

const COLUMNS = 'id, name, phone, village, district, region, verified, ug_village_id';

interface Args {
  villageId: number | null;
  villageName: string | null;
  districtName?: string | null;
  enabled?: boolean;
}

export function useLc1ForVillage({ villageId, villageName, districtName, enabled = true }: Args) {
  const village = (villageName || '').trim();

  const query = useQuery({
    queryKey: ['lc1-for-village', villageId, village.toLowerCase(), (districtName || '').toLowerCase()],
    enabled: enabled && (villageId != null || village.length >= 2),
    staleTime: 60_000,
    queryFn: async (): Promise<Lc1VillageMatch[]> => {
      // 1. Dataset-backed link.
      if (villageId != null) {
        const { data, error } = await supabase
          .from('lc1_chairpersons')
          .select(COLUMNS)
          .eq('ug_village_id', villageId)
          .order('verified', { ascending: false, nullsFirst: false })
          .limit(10);
        if (error) throw error;
        if (data && data.length > 0) return data as Lc1VillageMatch[];
      }

      // 2. Legacy name match.
      if (village.length < 2) return [];
      let builder = supabase
        .from('lc1_chairpersons')
        .select(COLUMNS)
        .ilike('village', village)
        .order('verified', { ascending: false, nullsFirst: false })
        .limit(10);
      if (districtName && districtName.trim()) {
        builder = builder.ilike('district', districtName.trim());
      }
      const { data, error } = await builder;
      if (error) throw error;
      if (data && data.length > 0) return data as Lc1VillageMatch[];

      // 3. Same village name, district unknown or mismatched on the record.
      if (districtName && districtName.trim()) {
        const { data: loose, error: looseError } = await supabase
          .from('lc1_chairpersons')
          .select(COLUMNS)
          .ilike('village', village)
          .order('verified', { ascending: false, nullsFirst: false })
          .limit(10);
        if (looseError) throw looseError;
        return (loose || []) as Lc1VillageMatch[];
      }
      return [];
    },
  });

  const matches = query.data ?? [];
  return {
    matches,
    /** Best candidate: a verified chairperson when one exists. */
    best: matches.find((m) => m.verified) ?? matches[0] ?? null,
    isLoading: query.isLoading || query.isFetching,
    /** True once a lookup ran for this village and found nothing. */
    isEmpty: query.isSuccess && matches.length === 0,
    error: query.error,
  };
}

export default useLc1ForVillage;
