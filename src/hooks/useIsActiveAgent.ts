import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

/**
 * An active agent has at least one tenant whose Rent Plan is repaying (recorded by them or assigned to them).
 * Agent-only prompts (the weekly streak, agent announcements) are shown to active agents only; most users
 * who hold the agent role have never collected.
 */
export function useIsActiveAgent(enabled = true) {
  const { user } = useAuth();
  const uid = user?.id;
  return useQuery({
    queryKey: ['agent-has-repaying-tenants', uid],
    enabled: enabled && !!uid,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { count, error } = await supabase
        .from('rent_requests')
        .select('id', { count: 'exact', head: true })
        .or(`agent_id.eq.${uid},assigned_agent_id.eq.${uid}`)
        .eq('status', 'repaying');
      if (error) throw error;
      return (count ?? 0) > 0;
    },
  });
}
