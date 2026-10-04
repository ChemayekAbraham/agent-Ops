import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Count of agent advance requests that have cleared Agent Ops and are now
 * waiting on the CFO to disburse — i.e. status is 'agent_ops_approved'
 * (awaiting CFO evaluation) or 'cfo_approved' (approved, money not yet moved).
 * Used to badge the CFO "Advances" menu item so the CFO always sees how many
 * advances are pending disbursement. Kept live via realtime.
 */
export function useCfoAdvanceDisbursementCount() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['cfo-advance-disbursement-count'],
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { count, error } = await supabase
        .from('agent_advance_requests_privileged')
        .select('id', { count: 'exact', head: true })
        .in('status', ['agent_ops_approved', 'cfo_approved']);
      if (error) throw error;
      return count ?? 0;
    },
  });

  useEffect(() => {
    const channel = supabase
      .channel('cfo-advance-disbursement-count')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'agent_advance_requests' },
        () => {
          queryClient.invalidateQueries({ queryKey: ['cfo-advance-disbursement-count'] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  return query.data ?? 0;
}
