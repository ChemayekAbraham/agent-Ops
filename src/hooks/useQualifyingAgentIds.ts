import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Canonical, behavior-based set of qualifying agent ids.
 *
 * An agent is someone who has (directly or via a qualifying sub-agent /
 * referral) done at least ONE of:
 *   - listed a house
 *   - posted a promissory note
 *   - made a rent request on behalf of a tenant (not their own)
 *   - added a sub-agent who themselves qualifies
 *
 * This is the SINGLE source of truth used to filter every agent list in the
 * Agent Ops dashboard so "who is an agent" stays consistent system-wide.
 */
export function useQualifyingAgentIds() {
  const query = useQuery({
    queryKey: ['agent-ops-qualifying-agent-ids'],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('agent_ops_qualifying_agent_ids');
      if (error) throw error;
      const ids = ((data ?? []) as Array<{ agent_id: string }>)
        .map((r) => r.agent_id)
        .filter(Boolean);
      return new Set<string>(ids);
    },
  });

  return {
    agentIds: query.data ?? new Set<string>(),
    isLoading: query.isLoading,
    /** true once the set has loaded (so callers can avoid filtering to empty) */
    isReady: query.isSuccess,
  };
}
