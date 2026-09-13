import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

/**
 * Is the signed-in user the designated CFO approver?
 *
 * Presentation only. The real restriction lives in the database
 * (`public.is_cfo_approver`, enforced inside every CFO decision RPC) and in the
 * shared edge-function gate, so a hidden or re-enabled button changes nothing.
 */
export function useCfoApprovalAuthority() {
  const { user } = useAuth();

  const query = useQuery({
    queryKey: ['cfo-approval-authority', user?.id],
    enabled: !!user?.id,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('is_cfo_approver', { _user_id: user!.id });
      if (error) throw error;
      return data === true;
    },
  });

  return {
    canApprove: query.data === true,
    loading: query.isLoading,
    error: query.error as Error | null,
  };
}

export default useCfoApprovalAuthority;
