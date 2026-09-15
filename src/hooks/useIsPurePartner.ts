import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Single source of truth for the "pure partner" payout carve-out.
 *
 * Calls the SAME server function the withdrawal destination gate uses
 * (`public.user_is_pure_partner`) so the withdrawal dialog can never demand a
 * verification step that the server would waive — and never waive one the
 * server would demand. Pure partner = one or more live portfolios AND no agent
 * activity (no collections, no tenant rent requests, no agent role).
 *
 * Read-only. No wallet/ledger state is touched here.
 */
export function useIsPurePartner(userId?: string | null) {
  const q = useQuery({
    queryKey: ['is-pure-partner', userId],
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase.rpc('user_is_pure_partner', {
        p_user_id: userId as string,
      });
      if (error) throw error;
      return data === true;
    },
  });

  return {
    isPurePartner: q.data === true,
    isLoading: q.isLoading || q.isFetching,
  };
}
