import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type EliteTier = 'diamond' | 'platinum' | 'gold' | 'silver';

export interface EliteRankRow {
  agent_id: string;
  rank_position: number;
  tier_name: EliteTier;
  composite_score: number;
  collection_score: number;
  network_score: number;
  activity_score: number;
  full_name: string | null;
  avatar_url: string | null;
}

/** All four elite ranks, fetched once and shared. Look up by user id; never query per row. */
export function useEliteRanks() {
  const q = useQuery({
    queryKey: ['elite-ranks-all'],
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_elite_ranks')
        .select('agent_id, rank_position, tier_name, composite_score, collection_score, network_score, activity_score')
        .order('rank_position', { ascending: true });
      if (error) throw error;
      const rows = data ?? [];
      const ids = rows.map((r) => r.agent_id);
      const { data: profs } = ids.length
        ? await supabase.from('profiles').select('id, full_name, avatar_url').in('id', ids)
        : { data: [] as { id: string; full_name: string | null; avatar_url: string | null }[] };
      const byId = new Map((profs ?? []).map((p) => [p.id, p]));
      return rows.map((r) => ({
        ...r,
        tier_name: r.tier_name as EliteTier,
        full_name: byId.get(r.agent_id)?.full_name ?? null,
        avatar_url: byId.get(r.agent_id)?.avatar_url ?? null,
      })) as EliteRankRow[];
    },
  });
  const tierOf = (id?: string | null): EliteTier | undefined =>
    id ? q.data?.find((r) => r.agent_id === id)?.tier_name : undefined;
  return { ...q, ranks: q.data ?? [], tierOf };
}
