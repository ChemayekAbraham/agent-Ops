import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

/**
 * The signed-in agent's standing for withdrawing landlord float: their collection rate against the minimum set by the server.
 * Read from get_agent_landlord_float_status(), the same answer the database gate uses, so what the agent is told here is exactly what
 * would happen if they tried. The database still enforces it; this only lets the dialogs say so before the agent starts.
 *
 * If the status cannot be read the agent is treated as allowed (and no notice is shown): the gate itself is never skipped.
 */
export interface LandlordFloatPerformance {
  /** 'rolling_7d' (the last 7 days) or 'week_to_date' / 'last_week_final' (the Thursday to Wednesday week). */
  basis: string;
  weekStart: string | null;
  weekEnd: string | null;
  expected: number;
  collected: number;
  /** null when nothing is expected from the agent: no minimum applies. */
  ratePct: number | null;
  /** Amount still needed to reach the bar (server column is still named shortfall_to_50; it is NOT a 50% figure). */
  shortfallTo50: number;
  /** The target rate from the server (e.g. 20), null if not sent. */
  requiredPct: number | null;
  meetsMinimum: boolean;
  /** Set when management has allowed this agent to withdraw this week despite being under 50%. */
  exceptionReason: string | null;
  canWithdraw: boolean;
  /** The sentence the agent would be sent if refused. */
  message: string | null;
}

export function useLandlordFloatPerformance() {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ['landlord-float-performance', user?.id ?? ''],
    enabled: !!user?.id,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: 1,
    queryFn: async (): Promise<LandlordFloatPerformance | null> => {
      const { data, error } = await (supabase.rpc as any)('get_agent_landlord_float_status', { p_agent_id: null });
      if (error) {
        console.warn('[useLandlordFloatPerformance] could not read the status', error);
        return null;
      }
      const r = (Array.isArray(data) ? data[0] : data) as Record<string, any> | null;
      if (!r) return null;
      const num = (v: unknown) => (v == null ? 0 : Number(v));
      return {
        basis: String(r.basis ?? 'rolling_7d'),
        weekStart: r.week_start ?? null,
        weekEnd: r.week_end ?? null,
        expected: num(r.expected),
        collected: num(r.collected),
        ratePct: r.rate_pct == null ? null : Number(r.rate_pct),
        shortfallTo50: num(r.shortfall_to_50),
        requiredPct: r.required_pct == null ? null : (Number(r.required_pct) <= 1 ? Number(r.required_pct) * 100 : Number(r.required_pct)),
        meetsMinimum: !!r.meets_minimum,
        exceptionReason: r.exception_reason ?? null,
        canWithdraw: r.can_withdraw !== false,
        message: r.message ?? null,
      };
    },
  });

  const perf = query.data ?? null;
  return {
    performance: perf,
    isLoading: query.isLoading,
    /** True only when the database says this agent cannot withdraw right now. */
    blocked: !!perf && !perf.canWithdraw,
  };
}
