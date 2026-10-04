import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { SUBMITTED_STATUSES, APPROVED_STATUSES } from '@/components/agent/AgentRequestPipelineView';

export function useAgentPipelineCounts() {
  const { user } = useAuth();

  const submitted = useQuery({
    queryKey: ['agent-pipeline-count', 'submitted', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { count, error } = await supabase
        .from('rent_requests')
        .select('*', { count: 'exact' })
        .eq('agent_id', user!.id)
        .in('status', SUBMITTED_STATUSES)
        .limit(0);
      if (error) throw error;
      return count ?? 0;
    },
  });

  const approved = useQuery({
    queryKey: ['agent-pipeline-count', 'approved', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { count, error } = await supabase
        .from('rent_requests')
        .select('*', { count: 'exact' })
        .eq('agent_id', user!.id)
        .in('status', APPROVED_STATUSES)
        .limit(0);
      if (error) throw error;
      return count ?? 0;
    },
  });

  const rejected = useQuery({
    queryKey: ['agent-pipeline-count', 'rejected', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { count, error } = await supabase
        .from('rent_requests')
        .select('*', { count: 'exact' })
        .eq('agent_id', user!.id)
        .eq('status', 'rejected')
        .limit(0);
      if (error) throw error;
      return count ?? 0;
    },
  });

  return {
    submittedCount: submitted.data ?? 0,
    approvedCount: approved.data ?? 0,
    rejectedCount: rejected.data ?? 0,
    isLoading: submitted.isLoading || approved.isLoading || rejected.isLoading,
  };
}
