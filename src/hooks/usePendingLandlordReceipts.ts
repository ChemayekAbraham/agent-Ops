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

/**
 * How far back we chase a missing receipt. Older unconfirmed payouts are an
 * operations problem (FinOps/Agent Ops follow-up), not something we should keep
 * nagging the agent about on every page load — the ask was explicitly "don't
 * show old ones, we need new payouts made".
 */
const RECENT_DAYS = 7;

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

  const query = useQuery({
    queryKey: ['pending-landlord-receipts', agentId],
    enabled: Boolean(agentId) && enabled,
    // Money screen: never serve a cached copy that could nag about a payout
    // whose receipt was already filed (or hide a fresh one).
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: async (): Promise<PendingLandlordReceipt[]> => {
      const since = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from('landlord_payouts')
        .select('id, amount, landlord_name, landlord_phone, tenant_id, disbursed_at, created_at')
        .eq('agent_id', agentId!)
        .eq('status', 'awaiting_agent_receipt')
        .is('receipt_number', null)
        .gte('created_at', since)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as PendingLandlordReceipt[];
    },
  });

  return {
    pending: query.data ?? [],
    pendingCount: query.data?.length ?? 0,
    loading: query.isLoading,
    refetch: query.refetch,
  };
}
