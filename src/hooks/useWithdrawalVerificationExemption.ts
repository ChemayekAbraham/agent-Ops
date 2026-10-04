import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Read-only check for the one-time per-withdrawal grandfather exemption
 * (`withdrawal_verification_exemptions`, exemption_type 'legacy_pending_cutoff').
 *
 * It waives ONLY the payout-destination / National-ID verification gate for
 * withdrawals that were already pending at the cutoff. It never marks a payout
 * destination verified and never applies to withdrawals created afterwards.
 */
export function useWithdrawalVerificationExemption(withdrawalId?: string | null) {
  const { data } = useQuery({
    queryKey: ['withdrawal-verification-exemption', withdrawalId],
    enabled: !!withdrawalId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('withdrawal_verification_exemptions')
        .select('id, exemption_type, active')
        .eq('withdrawal_id', withdrawalId as string)
        .eq('active', true)
        .maybeSingle();
      if (error) return null;
      return data ?? null;
    },
  });

  return { isExempt: !!data, exemption: data ?? null };
}
