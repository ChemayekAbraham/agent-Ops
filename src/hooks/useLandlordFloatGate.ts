import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

/**
 * Whether the signed-in agent's Landlord Float is locked: under the 50% collection minimum with no exception this week.
 * Read from get_landlord_float_gate(), the same pattern as the money withdrawal lock (get_withdraw_context): the server says
 * locked + the reason, the card locks and shows it, and a database rule refuses the withdrawal anyway.
 *
 * If the function is not there yet or cannot be read, the card is NOT locked (the database rule still refuses the withdrawal).
 */
export interface LandlordFloatGate {
  locked: boolean;
  /** The sentence to show on the locked card. */
  blockReason: string | null;
  ratePct: number | null;
  shortfallTo50: number;
  exceptionReason: string | null;
}

export function useLandlordFloatGate() {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ['landlord-float-gate', user?.id ?? ''],
    enabled: !!user?.id,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: 1,
    queryFn: async (): Promise<LandlordFloatGate | null> => {
      const { data, error } = await (supabase.rpc as any)('get_landlord_float_gate', { p_agent_id: null });
      if (error) return null;
      const r = (Array.isArray(data) ? data[0] : data) as Record<string, any> | null;
      if (!r) return null;
      return {
        locked: !!r.locked,
        blockReason: r.block_reason ?? null,
        ratePct: r.rate_pct == null ? null : Number(r.rate_pct),
        shortfallTo50: r.shortfall_to_50 == null ? 0 : Number(r.shortfall_to_50),
        exceptionReason: r.exception_reason ?? null,
      };
    },
  });
  return { gate: query.data ?? null, locked: !!query.data?.locked, isLoading: query.isLoading };
}
