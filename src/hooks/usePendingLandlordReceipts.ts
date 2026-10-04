import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export type PendingLandlordReceipt = {
  id: string;
  amount: number;
  landlord_name: string;
  landlord_phone: string | null;
  tenant_id: string | null;
  disbursed_at: string | null;
  created_at: string;
};

/** Receipt confirmation starts Monday, 21 September 2026 in Kampala. */
export const LANDLORD_RECEIPT_EFFECTIVE_AT = '2026-09-21T00:00:00+03:00';

export function isLandlordReceiptConfirmationEffective(now = new Date()): boolean {
  return now.getTime() >= new Date(LANDLORD_RECEIPT_EFFECTIVE_AT).getTime();
}

/**
 * Landlord float payouts belonging to the signed-in agent that have been paid
 * out but still need the agent to confirm the landlord's receipt number.
 *
 * `awaiting_agent_receipt` is the only status that means "money is with the
 * landlord, receipt not filed" — a payout leaves it the moment the receipt is
 * confirmed, so this list empties itself.
 */
export function usePendingLandlordReceipts(enabled = true) {
  const { user } = useAuth();
  const agentId = user?.id ?? null;
  const isEffective = isLandlordReceiptConfirmationEffective();

  const query = useQuery({
    queryKey: ['pending-landlord-receipts', agentId],
    enabled: Boolean(agentId) && enabled && isEffective,
    // Money screen: never serve a cached copy that could nag about a payout
    // whose receipt was already filed (or hide a fresh one).
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: async (): Promise<PendingLandlordReceipt[]> => {
      if (!agentId) return [];
      const { data, error } = await supabase
        .from('landlord_payouts')
        .select('id, amount, landlord_name, landlord_phone, tenant_id, disbursed_at, created_at')
        .eq('agent_id', agentId)
        .eq('status', 'awaiting_agent_receipt')
        .is('receipt_number', null)
        .gte('disbursed_at', LANDLORD_RECEIPT_EFFECTIVE_AT)
        .order('disbursed_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as PendingLandlordReceipt[];
    },
  });

  return {
    pending: isEffective ? query.data ?? [] : [],
    pendingCount: isEffective ? query.data?.length ?? 0 : 0,
    loading: isEffective && query.isLoading,
    refetch: query.refetch,
  };
}
