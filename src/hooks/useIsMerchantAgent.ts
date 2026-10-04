import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

/**
 * A Merchant Agent (a.k.a. Cash-out Agent) is an agent with an ACTIVE row in
 * `cashout_agents`. Per company policy a Merchant Agent is SOLELY a payout
 * operator: they may process MoMo / bank / cash payouts but must NOT perform
 * operational agent duties — no tenant operations (invite / pay / repay / post
 * rent requests), no landlord operations (payouts / registration), and no
 * listing of empty houses.
 *
 * Use `isMerchantAgent` to hide/guard those operational surfaces.
 */
export function useIsMerchantAgent(userIdOverride?: string) {
  const { user } = useAuth();
  const userId = userIdOverride ?? user?.id;

  const { data, isLoading } = useQuery({
    queryKey: ['is-merchant-agent', userId],
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      if (!userId) return null;
      const { data } = await supabase
        .from('cashout_agents')
        .select('id, is_active, handles_cash, label')
        .eq('agent_id', userId)
        .eq('is_active', true)
        .maybeSingle();
      return data;
    },
  });

  return {
    isMerchantAgent: !!data,
    merchantAgentData: data ?? null,
    loading: isLoading,
  };
}

/** Human-readable message shown when a Merchant Agent tries an operational action. */
export const MERCHANT_RESTRICTION_MESSAGE =
  'Merchant Agents handle payouts only. Tenant, landlord and house-listing operations are disabled for this role.';
