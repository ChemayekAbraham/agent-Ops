import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * True when the signed-in user holds a funding portfolio. Those accounts are
 * exempt from the identity / payout-destination verification gates (enforced
 * server-side in `withdrawal_user_id_verified` and
 * `enforce_withdrawal_destination_verified`); this hook only mirrors that
 * exemption in the UI so exempt users are never shown a blocking message.
 */
export function useIsFunderWithPortfolio(userId?: string | null) {
  return useQuery({
    queryKey: ['is-funder-with-portfolio', userId],
    enabled: !!userId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await (supabase.rpc as any)('user_is_funder_with_portfolio', {
        p_user_id: userId,
      });
      if (error) return false;
      return data === true;
    },
  });
}

export default useIsFunderWithPortfolio;
