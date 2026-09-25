/**
 * Plan pace for the Calling Center caller view: days left in the plan, and
 * the amount per remaining day needed to finish on time. Reads
 * `cc_plan_pace()`, which is a thin read over `v_rent_plan_schedule` — the
 * same authoritative schedule view every other scheduled-rent figure in the
 * platform derives from. No client-side arithmetic beyond formatting.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface CcPlanPace {
  rent_request_id: string;
  term_end: string;
  total_amount: number;
  amount_repaid: number;
  outstanding: number;
  /** May be negative when the plan's term has already passed. */
  days_remaining: number;
  /** Null once the term has passed — there is no "on time" left to pace towards. */
  amount_per_remaining_day: number | null;
}

export function useCcPlanPace(rentRequestId: string | null) {
  return useQuery({
    queryKey: ['cc-plan-pace', rentRequestId],
    enabled: !!rentRequestId,
    staleTime: 60_000,
    queryFn: async (): Promise<CcPlanPace | null> => {
      const { data, error } = await anyDb.rpc('cc_plan_pace', { p_rent_request_id: rentRequestId });
      if (error) throw new Error(error.message);
      return (data ?? null) as CcPlanPace | null;
    },
  });
}
