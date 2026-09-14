/**
 * Funder-with-portfolio check.
 *
 * A funder who holds an investor portfolio was already vetted through the
 * portfolio flow (signed agreement, payout details captured on the portfolio),
 * so the National ID / selfie prompts and the payout-destination verification
 * gate are skipped for them. The database mirrors this in
 * `public.user_is_funder_with_portfolio(uuid)` so the exemption cannot drift
 * between screen and server.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const EXCLUDED = new Set(['cancelled', 'rejected', 'deleted']);

export function useIsFunderWithPortfolio(userId: string | null | undefined) {
  const query = useQuery({
    queryKey: ['is-funder-with-portfolio', userId],
    enabled: !!userId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase
        .from('investor_portfolios')
        .select('id, status')
        .eq('investor_id', userId!)
        .limit(50);
      if (error) throw error;
      return (data ?? []).some((r) => !EXCLUDED.has(String(r.status ?? '').toLowerCase()));
    },
  });

  return {
    isFunder: query.data === true,
    isLoading: query.isLoading || query.isFetching,
  };
}
