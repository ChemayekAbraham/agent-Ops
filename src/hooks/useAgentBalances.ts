import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useWalletBalance } from '@/hooks/wallet/useWalletBalance';
import { trackRequest } from '@/lib/costMonitor';

export interface AgentSplitBalances {
  withdrawableBalance: number;
  floatBalance: number;
  advanceBalance: number;
  /** True commission balance: sum(agent_commission_earned cash_in) − sum(commission cash_out). Always ≥ 0. */
  commissionBalance: number;
  /** Withdrawable funds NOT classified as commission (e.g. CFO admin-expense credits). Review with CFO. */
  otherBalance: number;
  /** Sum of in-flight withdrawal requests (pending/processing). Subtracted from withdrawable already. */
  pendingHolds: number;
  totalBalance: number;
}

export function useAgentBalances(agentId?: string) {
  const { user } = useAuth();
  const effectiveId = agentId || user?.id;

  // Canonical wallet view — shared across every card/dialog/hook on the
  // screen. This replaces the old per-hook `get_user_wallet_view` call
  // AND the 30-second poll: one in-flight request per user per tick,
  // realtime invalidation handles freshness.
  const w = useWalletBalance(effectiveId);

  // Commission netting still needs its own read (ledger rows) but is now
  // scoped to `['agent-commission', userId]` and de-duped by React Query
  // when the same agent's data is requested from multiple screens.
  const { data: commission, isLoading: commissionLoading, error: commissionError, refetch: refetchCommission } = useQuery({
    queryKey: ['agent-commission-net', effectiveId],
    enabled: !!effectiveId,
    staleTime: 15_000,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 0,
    queryFn: async (): Promise<number> => {
      trackRequest('db', 'agent-commission-net');
      const { data, error } = await supabase
        .from('general_ledger')
        .select('amount, direction, category')
        .eq('user_id', effectiveId as string)
        .eq('ledger_scope', 'wallet')
        .in('category', [
          'agent_commission_earned',
          'agent_commission',
          'agent_bonus',
          'agent_commission_withdrawal',
          'agent_commission_used_for_rent',
          'partner_commission',
        ])
        .limit(5000);
      if (error) throw error;
      // Net cash_in vs cash_out per row — see SSENKAALI PIUS 2026-04-27
      // note in git blame for background.
      let bal = 0;
      for (const row of (data ?? []) as any[]) {
        const amt = Number(row.amount) || 0;
        if (row.direction === 'cash_in' || row.direction === 'credit') bal += amt;
        else if (row.direction === 'cash_out' || row.direction === 'debit') bal -= amt;
      }
      return Math.max(0, bal);
    },
  });

  const commissionBalance = commissionError
    ? w.withdrawable
    : (commission ?? 0);
  const otherBalance = Math.max(0, w.withdrawable - commissionBalance);

  const data: AgentSplitBalances = {
    withdrawableBalance: w.withdrawable,
    floatBalance: w.floatBalance,
    advanceBalance: w.advanceBalance,
    commissionBalance,
    otherBalance,
    pendingHolds: w.pendingHolds,
    totalBalance: w.withdrawable + w.floatBalance,
  };

  // NOTE: `isLoading` and `error` reflect ONLY the canonical wallet-view
  // fetch (withdrawable / float / advance). The commission split query
  // can be slow OR fail for high-volume agents (5000-row cap, timeouts)
  // and must NEVER gate the "Pay from Wallet Float" button — otherwise
  // agents see "Couldn't load your Wallet Float" or a stuck "Loading
  // float…" even after their float balance has already arrived from
  // `get_user_wallet_view`. Commission errors are exposed separately.
  const isLoading = w.isLoading;
  const isCommissionLoading = commissionLoading;
  const error = w.error ?? null;
  const commissionErrorOut = commissionError ?? null;
  const refetch = async () => {
    await Promise.all([w.refetch(), refetchCommission()]);
  };

  return {
    withdrawableBalance: data.withdrawableBalance,
    floatBalance: data.floatBalance,
    advanceBalance: data.advanceBalance,
    commissionBalance: data.commissionBalance,
    otherBalance: data.otherBalance,
    pendingHolds: data.pendingHolds,
    totalBalance: data.totalBalance,
    isLoading,
    isCommissionLoading,
    error,
    commissionError: commissionErrorOut,
    refetch,
  };
}
