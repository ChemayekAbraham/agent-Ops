import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Count of brand-new agent advance requests awaiting Agent Ops review
 * (status = 'pending'). Agent Ops is the only operational desk — once it
 * approves, requests go straight to the CFO. Used to badge the Agent Ops
 * "Advances" menu item. Kept live via realtime on agent_advance_requests.
 */
export function usePendingAdvanceCount() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['pending-advance-count'],
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { count, error } = await supabase
        .from('agent_advance_requests_privileged')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending');
      if (error) throw error;
      return count ?? 0;
    },
  });

  useEffect(() => {
    const channel = supabase
      .channel('pending-advance-count')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'agent_advance_requests' },
        () => {
          queryClient.invalidateQueries({ queryKey: ['pending-advance-count'] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  return query.data ?? 0;
}
