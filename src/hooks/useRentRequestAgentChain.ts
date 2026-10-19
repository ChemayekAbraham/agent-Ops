import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { CHAIN_BATCH_LIMIT, chainIdsKey, normalizeAgentChain, type AgentChain } from '@/lib/rentAgentChain';

/**
 * Registering agent, verified main agent and assigned agent for the requests a desk has ALREADY loaded: one call per desk (rent_request_agent_chain),
 * never one per card. The server decides who the main agent is (a verified sub-agent link only) and which phone belongs to which person.
 * Read-only. At most 200 ids per call; `omitted` says how many were not asked for. A failure is an error and the cards fall back to their own agent line.
 */
export function useRentRequestAgentChain(ids: string[], options: { enabled?: boolean } = {}) {
  const unique = useMemo(() => [...new Set(ids.filter(Boolean))], [ids]);
  const asked = useMemo(() => unique.slice(0, CHAIN_BATCH_LIMIT), [unique]);
  const key = useMemo(() => chainIdsKey(asked), [asked]);
  const q = useQuery({
    queryKey: ['rent-request-agent-chain', key],
    enabled: (options.enabled ?? true) && asked.length > 0,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<AgentChain[]> => {
      const { data, error } = await supabase.rpc('rent_request_agent_chain', { p_request_ids: asked });
      if (error) throw error;
      return normalizeAgentChain(data);
    },
  });
  const byId = useMemo(() => {
    const m = new Map<string, AgentChain>();
    (q.data ?? []).forEach((c) => m.set(c.request_id, c));
    return m;
  }, [q.data]);
  return {
    byId,
    omitted: Math.max(0, unique.length - asked.length),
    isLoading: q.isLoading,
    error: q.error ?? null,
    refetch: () => { void q.refetch(); },
  };
}
