import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useWalletRealtime } from '@/hooks/useWalletRealtime';

// Realtime can miss events across a dropped/backgrounded socket. This
// gates the visibility-change catch-up refetch below (not a poll — only
// fires on an actual visibility/focus transition, and only if the data
// is actually old enough that a missed event is plausible).
const STALE_AFTER_MS = 30_000;

/**
 * "What I owe Welile" — total company exposure on an agent's book.
 *
 * Pure read-only aggregation over data the app already queries:
 *   - rent_requests where agent_id = me  (cycles funded by Welile)
 *   - subscription_charges where agent_id = me  (guarantor debt)
 *   - agent_advances.outstanding_balance, active + overdue  (personal advance —
 *     same source and filter as the CFO's Agents-with-Outstanding-Advances
 *     panel, so both dashboards show the same figure)
 *
 * Headline = outstandingCycles + subscriptionDebt + advanceBalance.
 * Lifetime totals are shown as context so the number isn't scary in isolation.
 */
export interface AgentCompanyExposure {
  outstandingCycles: number;
  lifetimeDisbursed: number;
  lifetimeRepaid: number;
  subscriptionDebt: number;
  advanceBalance: number;
  totalOwed: number;
  activeCycleCount: number;
  tenantCount: number;
}

export function useAgentCompanyExposure() {
  const { user } = useAuth();
  // NOTE: this previously passed no extraQueryKeys, so the realtime
  // subscription below never actually invalidated this query — the
  // refetchInterval/refetchOnWindowFocus poll was the only thing keeping
  // it fresh. Wiring the real query key here is what makes it safe to
  // drop that poll below.
  useWalletRealtime(user?.id, user?.id ? [['agent-company-exposure', user.id]] : []);

  const query = useQuery({
    queryKey: ['agent-company-exposure', user?.id],
    queryFn: async (): Promise<Omit<AgentCompanyExposure, 'totalOwed'>> => {
      if (!user?.id) {
        return {
          outstandingCycles: 0,
          lifetimeDisbursed: 0,
          lifetimeRepaid: 0,
          subscriptionDebt: 0,
          advanceBalance: 0,
          activeCycleCount: 0,
          tenantCount: 0,
        };
      }

      const ACTIVE = ['funded', 'disbursed', 'repaying'];
      const HISTORICAL = ['funded', 'disbursed', 'repaying', 'completed'];

      const [rentRes, chargesRes, advancesRes] = await Promise.all([
        supabase
          .from('rent_requests')
          .select('id, tenant_id, rent_amount, total_repayment, amount_repaid, status, agent_payment_status')
          .eq('agent_id', user.id)
          .in('status', HISTORICAL),
        supabase
          .from('subscription_charges')
          .select('accumulated_debt')
          .eq('agent_id', user.id)
          .eq('status', 'active'),
        supabase
          .from('agent_advances')
          .select('outstanding_balance')
          .eq('agent_id', user.id)
          .in('status', ['active', 'overdue'])
          .gt('outstanding_balance', 0),
      ]);

      const rows = rentRes.data || [];
      let lifetimeDisbursed = 0;
      let lifetimeRepaid = 0;
      let outstandingCycles = 0;
      let activeCycleCount = 0;
      const tenants = new Set<string>();

      for (const r of rows) {
        const disbursed = Number(r.rent_amount || 0);
        const owed = Number(r.total_repayment || 0);
        const repaid = Number(r.amount_repaid || 0);
        // Tenants the agent marked "Not Paying" (inactive) are excluded from the
        // live outstanding figure and the active cycle count — their house has
        // been freed back to Priority 1, so they no longer count against the book.
        const isInactive = ((r as any).agent_payment_status ?? 'paying') === 'not_paying';
        lifetimeDisbursed += disbursed;
        lifetimeRepaid += repaid;
        if (r.tenant_id) tenants.add(r.tenant_id);
        if (ACTIVE.includes(r.status as string) && !isInactive) {
          activeCycleCount += 1;
          outstandingCycles += Math.max(0, owed - repaid);
        }
      }

      const subscriptionDebt = (chargesRes.data || []).reduce(
        (s, c: any) => s + Number(c.accumulated_debt || 0),
        0,
      );

      const advanceBalance = (advancesRes.data || []).reduce(
        (s, a: any) => s + Number(a.outstanding_balance || 0),
        0,
      );

      return {
        outstandingCycles,
        lifetimeDisbursed,
        lifetimeRepaid,
        subscriptionDebt,
        advanceBalance,
        activeCycleCount,
        tenantCount: tenants.size,
      };
    },
    enabled: !!user?.id,
    staleTime: 15_000,
  });

  useEffect(() => {
    if (!user?.id) return;
    const onFocus = () => {
      if (document.visibilityState !== 'visible') return;
      if (!query.dataUpdatedAt) return;
      if (Date.now() - query.dataUpdatedAt > STALE_AFTER_MS) {
        void query.refetch();
      }
    };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, query.dataUpdatedAt]);

  const data = query.data;
  const advanceBalance = data?.advanceBalance ?? 0;
  const totalOwed =
    (data?.outstandingCycles ?? 0) + (data?.subscriptionDebt ?? 0) + advanceBalance;

  return {
    ...(data ?? {
      outstandingCycles: 0,
      lifetimeDisbursed: 0,
      lifetimeRepaid: 0,
      subscriptionDebt: 0,
      activeCycleCount: 0,
      tenantCount: 0,
    }),
    advanceBalance,
    totalOwed,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  } as AgentCompanyExposure & {
    isLoading: boolean;
    error: unknown;
    refetch: () => void;
  };
}
