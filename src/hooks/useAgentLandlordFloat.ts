import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Returns the agent's landlord-payout float from `agent_landlord_float.balance`.
 *
 * This is the CFO-allocated pool the agent uses to pay landlords — it is
 * intentionally separate from the wallet ledger float bucket. Reads go
 * straight to the `agent_landlord_float` row so the CFO's disbursement is
 * what the agent sees and spends against.
 */
export function useAgentLandlordFloat(agentId?: string) {
  const { user } = useAuth();
  const effectiveId = agentId || user?.id;
  const queryClient = useQueryClient();

  const balanceKey = ['agent-landlord-payout-float-balance', effectiveId ?? ''];
  const availableKey = ['agent-landlord-payout-float-available', effectiveId ?? ''];

  // Also listen for deposit_requests transitions (pending → approved) so the
  // float shows up the moment FinOps / auto-credit flips the row, even if
  // the ledger insert event is debounced behind it.
  useEffect(() => {
    if (!effectiveId) return;
    const channel = supabase
      .channel(`agent-float-deposits-${effectiveId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'deposit_requests',
          filter: `user_id=eq.${effectiveId}`,
        },
        () => {
          queryClient.invalidateQueries({ queryKey: balanceKey });
          queryClient.invalidateQueries({ queryKey: ['agent-split-balances', effectiveId] });
          queryClient.invalidateQueries({ queryKey: ['wallet', effectiveId] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [effectiveId, queryClient]);

  // Landlord Payout Float is NOT wallet float. Subscribe only to the dedicated
  // payout-pool table so wallet float updates can never overwrite this cache.
  useEffect(() => {
    if (!effectiveId) return;
    const channel = supabase
      .channel(`agent-landlord-payout-float-${effectiveId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'agent_landlord_float',
          filter: `agent_id=eq.${effectiveId}`,
        },
        () => {
          queryClient.invalidateQueries({ queryKey: balanceKey });
          queryClient.invalidateQueries({ queryKey: availableKey });
          queryClient.invalidateQueries({ queryKey: ['agent-landlord-float-row', effectiveId] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [effectiveId, queryClient]);

  const query = useQuery({
    queryKey: balanceKey,
    queryFn: async (): Promise<number> => {
      if (!effectiveId) return 0;
      const { data, error } = await supabase
        .from('agent_landlord_float')
        .select('balance')
        .eq('agent_id', effectiveId)
        .maybeSingle();
      if (error) throw error;
      const n = Number(data?.balance ?? 0);
      return Number.isFinite(n) ? n : 0;
    },
    enabled: !!effectiveId,
    // Float is safety-critical for landlord payouts; never serve stale.
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: 30_000,
  });

  // Spendable float — gross balance minus amounts already ring-fenced by
  // landlord payouts that are verified but not yet paid out. This is the
  // SAME figure the disbursement backend enforces, so the agent can never
  // be told they have money the payout will then refuse to spend.
  const availableQuery = useQuery({
    queryKey: availableKey,
    queryFn: async (): Promise<number> => {
      if (!effectiveId) return 0;
      const { data, error } = await supabase.rpc('get_agent_lp_float_available', {
        p_agent_id: effectiveId,
      });
      if (error) throw error;
      const n = Number(data ?? 0);
      return Number.isFinite(n) ? n : 0;
    },
    enabled: !!effectiveId,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: 30_000,
  });

  return {
    floatBalance: query.data ?? 0,
    // Reservation-aware spendable amount (backend-authoritative).
    availableBalance: availableQuery.data ?? 0,
    reservedBalance: Math.max(0, (query.data ?? 0) - (availableQuery.data ?? 0)),
    isLoading: query.isLoading || availableQuery.isLoading,
    error: query.error || availableQuery.error,
    refetch: async () => {
      await Promise.all([query.refetch(), availableQuery.refetch()]);
    },
  };
}