import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export function useIsFinancialAgent() {
  const { user } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ['is-financial-agent', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data } = await supabase
        .from('financial_agents')
        .select('id, is_active, label')
        .eq('agent_id', user.id)
        .eq('is_active', true)
        .maybeSingle();
      return data;
    },
    enabled: !!user?.id,
  });

  return {
    isFinancialAgent: !!data,
    financialAgentData: data,
    loading: isLoading,
  };
}
