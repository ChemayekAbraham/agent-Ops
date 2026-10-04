import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type EligibilityRating =
  | 'Very Good' | 'Good' | 'Fair' | 'Bad' | 'Very Bad' | 'Starter';

export type EligibilityHistoryRow = {
  agent_id: string;
  day: string;            // YYYY-MM-DD
  expected_daily: number;
  paid: number;
  ratio: number;          // 0..1+
  rating: EligibilityRating;
  status: 'starter' | 'good' | 'blocked';
  active_count: number;
};

/**
 * Per-agent daily eligibility history (last N days, default 90).
 * Returns rows ordered most-recent first.
 */
export function useAgentEligibilityHistory(agentId: string | undefined | null, days = 90) {
  return useQuery({
    queryKey: ['agent-eligibility-history', agentId, days],
    enabled: !!agentId,
    staleTime: 60_000,
    queryFn: async (): Promise<EligibilityHistoryRow[]> => {
      if (!agentId) return [];
      const cutoff = new Date(Date.now() - days * 86_400_000)
        .toISOString().slice(0, 10);
      const { data, error } = await (supabase as any)
        .from('agent_daily_eligibility_history')
        .select('agent_id, day, expected_daily, paid, ratio, rating, status, active_count')
        .eq('agent_id', agentId)
        .gte('day', cutoff)
        .order('day', { ascending: false });
      if (error) throw error;
      return (data || []) as EligibilityHistoryRow[];
    },
  });
}

export type EligibilityTransition = EligibilityHistoryRow & {
  agent_name: string;
  agent_phone: string | null;
  previous_rating: EligibilityRating;
  direction: 'up' | 'down';
};

const RATING_ORDER: Record<EligibilityRating, number> = {
  'Very Bad': 0, 'Bad': 1, 'Fair': 2, 'Good': 3, 'Very Good': 4, 'Starter': 2,
};

/**
 * Fleet-wide eligibility transitions (rating changed vs the previous day) for
 * the last `days` days. Sorted most-recent first.
 */
export function useAgentEligibilityTransitions(days = 90, limit = 200) {
  return useQuery({
    queryKey: ['agent-eligibility-transitions', days, limit],
    staleTime: 60_000,
    queryFn: async (): Promise<EligibilityTransition[]> => {
      const cutoff = new Date(Date.now() - days * 86_400_000)
        .toISOString().slice(0, 10);
      const { data, error } = await (supabase as any)
        .from('agent_daily_eligibility_history')
        .select('agent_id, day, expected_daily, paid, ratio, rating, status, active_count')
        .gte('day', cutoff)
        .order('agent_id', { ascending: true })
        .order('day', { ascending: true });
      if (error) throw error;
      const rows = (data || []) as EligibilityHistoryRow[];

      // Walk per-agent, emit a transition whenever rating changes from prior day.
      const transitions: Array<EligibilityHistoryRow & {
        previous_rating: EligibilityRating;
        direction: 'up' | 'down';
      }> = [];
      let lastAgent: string | null = null;
      let lastRating: EligibilityRating | null = null;
      for (const r of rows) {
        if (r.agent_id !== lastAgent) {
          lastAgent = r.agent_id;
          lastRating = r.rating;
          continue;
        }
        if (lastRating && r.rating !== lastRating) {
          const dir: 'up' | 'down' =
            RATING_ORDER[r.rating] >= RATING_ORDER[lastRating] ? 'up' : 'down';
          transitions.push({ ...r, previous_rating: lastRating, direction: dir });
        }
        lastRating = r.rating;
      }
      transitions.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));

      const top = transitions.slice(0, limit);
      const agentIds = Array.from(new Set(top.map(t => t.agent_id)));
      const profileMap = new Map<string, { name: string; phone: string | null }>();
      if (agentIds.length > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', agentIds);
        (profs || []).forEach((p: any) => {
          profileMap.set(p.id, { name: p.full_name || 'Unknown', phone: p.phone });
        });
      }
      return top.map(t => {
        const p = profileMap.get(t.agent_id);
        return {
          ...t,
          agent_name: p?.name || t.agent_id.slice(0, 8),
          agent_phone: p?.phone || null,
        };
      });
    },
  });
}

export const RATING_TONE: Record<EligibilityRating, string> = {
  'Very Good': 'bg-emerald-600 text-white',
  'Good':      'bg-emerald-500 text-white',
  'Fair':      'bg-amber-500 text-white',
  'Bad':       'bg-orange-500 text-white',
  'Very Bad':  'bg-destructive text-white',
  'Starter':   'bg-violet-500 text-white',
};

export const RATING_TONE_SOFT: Record<EligibilityRating, string> = {
  'Very Good': 'bg-emerald-600/15 text-emerald-700 border-emerald-600/40',
  'Good':      'bg-emerald-500/15 text-emerald-700 border-emerald-500/40',
  'Fair':      'bg-amber-500/15 text-amber-700 border-amber-500/40',
  'Bad':       'bg-orange-500/15 text-orange-700 border-orange-500/40',
  'Very Bad':  'bg-destructive/15 text-destructive border-destructive/40',
  'Starter':   'bg-violet-500/15 text-violet-700 border-violet-500/40',
};