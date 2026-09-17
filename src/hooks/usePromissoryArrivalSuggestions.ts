import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Fuzzy "this partner may already be here" suggestions for promissory notes.
 *
 * The server only ever *suggests*: a note is linked to an account when an ops
 * user confirms it with a written reason. Word order, extra middle names and
 * spelling drift are tolerated (two shared name words, or a high similarity).
 */
export interface PromissoryArrivalSuggestion {
  note_id: string;
  partner_name: string;
  note_created_at: string;
  candidate_user_id: string;
  candidate_name: string;
  candidate_phone: string | null;
  candidate_created_at: string;
  shared_words: number;
  similarity: number;
  candidate_count: number;
  rank: number;
  confidence: 'high' | 'medium' | 'low';
}

export function usePromissoryArrivalSuggestions(
  from?: string | null,
  to?: string | null,
  enabled = true,
) {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['promissory-arrival-suggestions', from ?? 'all', to ?? 'all'],
    enabled,
    staleTime: 120_000,
    queryFn: async (): Promise<PromissoryArrivalSuggestion[]> => {
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>;
      const { data, error } = await rpc('promissory_fuzzy_arrival_suggestions', {
        p_from: from ?? null,
        p_to: to ?? null,
      });
      if (error) throw new Error(error.message);
      const res = (data ?? {}) as { suggestions?: PromissoryArrivalSuggestion[] };
      return res.suggestions ?? [];
    },
  });

  /** Best suggestion per note, keyed by note id. */
  const byNote = useMemo(() => {
    const map = new Map<string, PromissoryArrivalSuggestion[]>();
    for (const s of query.data ?? []) {
      const list = map.get(s.note_id) ?? [];
      list.push(s);
      map.set(s.note_id, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.rank - b.rank);
    return map;
  }, [query.data]);

  const confirm = useMutation({
    mutationFn: async (vars: { noteId: string; userId: string; reason: string }) => {
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>;
      const { data, error } = await rpc('promissory_confirm_arrival_match', {
        p_note_id: vars.noteId,
        p_user_id: vars.userId,
        p_reason: vars.reason,
      });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['promissory-arrival-suggestions'] });
      qc.invalidateQueries({ queryKey: ['promissory-ops-report'] });
    },
  });

  return {
    suggestions: query.data ?? [],
    byNote,
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
    confirm,
  };
}
