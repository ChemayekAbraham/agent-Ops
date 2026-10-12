import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import {
  planIdsSignature,
  type AmPlanArrearsRow,
  type AmPlanClockReading,
  type AmPlanClockRow,
} from '@/lib/agentMonitoringClockSchedule';

/** Rows per call: the API returns at most 1,000 rows, and one call carries one chunk. */
export const CLOCK_CHUNK = 500;
/** Chunks in flight at once. */
const PARALLEL_CHUNKS = 3;

/** One shared empty map so consumers' memo dependencies stay stable while loading. */
const NO_READINGS: ReadonlyMap<string, AmPlanClockReading> = new Map();

/**
 * Landlord-payout clock for the plans Agent Monitoring already loaded: when each plan's
 * repayments start counting, which bucket it is in, and what it should have paid and owes by
 * the selected day. Two read-only server functions, called once per chunk of plan ids (no
 * per-plan calls). Read-only; nothing is written.
 */
export function useAgentMonitoringClock(planIds: readonly string[], day: Date) {
  const asAt = format(day, 'yyyy-MM-dd');
  const signature = useMemo(() => planIdsSignature(planIds), [planIds]);

  const query = useQuery({
    queryKey: ['am-plan-clock', asAt, signature],
    enabled: planIds.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const chunks: string[][] = [];
      for (let index = 0; index < planIds.length; index += CLOCK_CHUNK) {
        chunks.push(planIds.slice(index, index + CLOCK_CHUNK) as string[]);
      }
      const readings = new Map<string, AmPlanClockReading>();
      for (let index = 0; index < chunks.length; index += PARALLEL_CHUNKS) {
        const group = chunks.slice(index, index + PARALLEL_CHUNKS);
        const results = await Promise.all(group.map(async (ids) => {
          const [clock, arrears] = await Promise.all([
            supabase.rpc('am_plan_clock', { p_rent_request_ids: ids }),
            supabase.rpc('am_plan_arrears', { p_rent_request_ids: ids, p_as_at: asAt }),
          ]);
          if (clock.error) throw new Error(clock.error.message);
          if (arrears.error) throw new Error(arrears.error.message);
          return {
            clock: (clock.data ?? []) as unknown as AmPlanClockRow[],
            arrears: (arrears.data ?? []) as unknown as AmPlanArrearsRow[],
          };
        }));
        results.forEach(({ clock, arrears }) => {
          const arrearsById = new Map(arrears.map((row) => [row.rent_request_id, row]));
          clock.forEach((row) => {
            const matching = arrearsById.get(row.rent_request_id);
            if (matching) readings.set(row.rent_request_id, { clock: row, arrears: matching });
          });
        });
      }
      return readings;
    },
  });

  return {
    /** Plan id -> both server readings. Empty until the query has succeeded. */
    readings: (query.data ?? NO_READINGS) as ReadonlyMap<string, AmPlanClockReading>,
    /** True once there is nothing left to wait for (also true when there are no plans). */
    ready: planIds.length === 0 || query.isSuccess,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}
