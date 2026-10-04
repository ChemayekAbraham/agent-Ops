import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export function useAgentHasRepayingTenant(agentId?: string | null) {
  return useQuery({
    queryKey: ['agent-has-repaying-tenant', agentId],
    enabled: !!agentId,
    staleTime: 60_000,
    queryFn: async (): Promise<boolean> => {
      if (!agentId) return false;
      const { data, error } = await supabase
        .from('rent_requests')
        .select('id')
        .eq('agent_id', agentId)
        .eq('status', 'repaying')
        .limit(1);
      if (error) throw error;
      return (data?.length ?? 0) > 0;
    },
  });
}
