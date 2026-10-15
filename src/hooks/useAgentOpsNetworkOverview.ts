import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { normalizeNetworkOverview, type AgentNetworkOverview } from '@/lib/agentNetwork';

/**
 * Read-only: the Agent Ops network overview for Kampala days start..end (yyyy-MM-dd), from get_agent_ops_network_overview. The server
 * decides every figure; this only fetches and types them. Cached for a minute per range.
 */
export function useAgentOpsNetworkOverview(start: string, end: string, enabled = true) {
  const q = useQuery({
    queryKey: ['agent-ops-network-overview', start, end],
    enabled: enabled && !!start && !!end,
    staleTime: 60_000,
    queryFn: async (): Promise<AgentNetworkOverview> => {
      const { data, error } = await supabase.rpc('get_agent_ops_network_overview', { p_start: start, p_end: end });
      if (error) throw error;
      return normalizeNetworkOverview(data);
    },
  });
  return {
    data: q.data ?? null,
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error ?? null,
    refetch: () => { void q.refetch(); },
  };
}
