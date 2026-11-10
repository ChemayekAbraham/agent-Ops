import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  SELF_SUPPORT_FEE_OFF,
  parseSelfSupportFeePolicy,
  selfSupportGross,
  selfSupportProxyFee,
  type SelfSupportFeePolicy,
} from '@/lib/selfSupportFee';

/**
 * The self-support agent facilitation fee policy (get_self_support_fee_policy, readable before login).
 *
 *   pay(rent)  what a partner pays to support this rent / empty house: rent + fee (= rent while off)
 *   fee(rent)  the fee part (0 while off)
 *
 * Every self-support amount a partner sees, adds up or compares with their balance must go through
 * pay(): the database charges pay(rent), so showing the plain rent would under-state the cost and let
 * a "you can afford this" check pass that the server then refuses.
 * While loading or on error the policy reads as OFF (amounts = rent), the same as the server default.
 */
export const SELF_SUPPORT_FEE_POLICY_QUERY_KEY = ['self-support-fee-policy'] as const;

export function useSelfSupportFeePolicy() {
  const { data, isLoading } = useQuery({
    queryKey: SELF_SUPPORT_FEE_POLICY_QUERY_KEY,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<SelfSupportFeePolicy> => {
      const { data, error } = await supabase.rpc('get_self_support_fee_policy' as never);
      if (error) throw error;
      return parseSelfSupportFeePolicy(data);
    },
  });

  const policy = data ?? SELF_SUPPORT_FEE_OFF;
  const pay = useCallback((rent: number) => selfSupportGross(rent, policy), [policy]);
  const fee = useCallback((rent: number) => selfSupportProxyFee(rent, policy), [policy]);

  return { policy, enabled: policy.enabled, ratePct: policy.rate * 100, pay, fee, isLoading };
}
