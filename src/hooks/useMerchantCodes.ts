import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { CommsChannel } from '@/hooks/useTenantCommunications';

/**
 * The live Welile merchant codes (the active rows of payment_channels, the same ones the Communications tab shows).
 *
 * This reads the table directly rather than through useTenantCommunications: that hook calls a report that only staff in the
 * wider ops/executive group may use, so it would refuse Tenant Ops, Agent Ops, Landlord Ops and service-centre callers, who all
 * use the awareness call panel. payment_channels is readable by any signed-in user and the codes are not secret.
 *
 * If the read fails (or returns nothing) the two long-standing codes are used instead, so the codes never disappear from a call.
 */
export const FALLBACK_MERCHANT_CODES: CommsChannel[] = [
  { provider: 'MTN', merchant_code: '090777', merchant_name: null, active: true },
  { provider: 'Airtel', merchant_code: '4380664', merchant_name: null, active: true },
];

export function useMerchantCodes(): CommsChannel[] {
  const q = useQuery({
    queryKey: ['payment-channels-active'],
    queryFn: async (): Promise<CommsChannel[]> => {
      const { data, error } = await supabase
        .from('payment_channels')
        .select('provider, merchant_code, merchant_name, active, sort_order')
        .eq('active', true)
        .order('sort_order', { ascending: true });
      if (error) throw error;
      return (data ?? []).map((r) => ({
        provider: r.provider, merchant_code: r.merchant_code, merchant_name: r.merchant_name, active: r.active,
      }));
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });
  return q.data && q.data.length > 0 ? q.data : FALLBACK_MERCHANT_CODES;
}
