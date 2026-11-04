import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { AGENT_WEEK_BATCH_LIMIT, chunkAgentWeekIds, normalizeAgentWeekPct, type AgentWeekPct } from '@/lib/agentWeekPct';

/**
 * The registering agent's collection percentage for the current Thursday-Wednesday week, for the requests a desk has ALREADY loaded.
 * One call per desk (a very large desk is sent in a few batches of 2000 requests), never one per card. `rent_request_agent_week_pct` reads the
 * same figures the agent sees on Weekly performance and returns one row per distinct registering agent. Read-only; kept for five minutes.
 * If it fails, the cards simply show no percentage and the desk keeps the order it already had.
 */
export function useAgentWeekPct(requestIds: string[], options: { enabled?: boolean } = {}) {
  const ids = useMemo(() => [...new Set(requestIds.filter(Boolean))].sort(), [requestIds]);
  const key = useMemo(() => {
    let h = 0x811c9dc5;
    for (const id of ids) {
      for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
      h ^= 0x2c; h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `${ids.length}:${h.toString(16)}`;
  }, [ids]);

  const q = useQuery({
    queryKey: ['rent-request-agent-week-pct', key],
    enabled: (options.enabled ?? true) && ids.length > 0,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
    retryDelay: 300,
    queryFn: async (): Promise<AgentWeekPct[]> => {
      const out: AgentWeekPct[] = [];
      for (const chunk of chunkAgentWeekIds(ids, AGENT_WEEK_BATCH_LIMIT)) {
        const { data, error } = await supabase.rpc('rent_request_agent_week_pct', { p_request_ids: chunk });
        if (error) throw error;
        out.push(...normalizeAgentWeekPct(data));
      }
      return out;
    },
  });

  const byAgent = useMemo(() => {
    const m = new Map<string, AgentWeekPct>();
    (q.data ?? []).forEach((w) => m.set(w.agent_id, w));
    return m;
  }, [q.data]);

  return { byAgent, isLoading: q.isLoading, error: q.error ?? null, refetch: () => { void q.refetch(); } };
}
