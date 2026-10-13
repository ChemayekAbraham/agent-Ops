import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { ClockDriftStatus } from '@/lib/payoutClockExplainer';

const anyDb = supabase as any;

/**
 * The latest daily check that Agent Monitoring, the Workspace and Weekly Performance count from the
 * same start (`get_am_clock_drift_status`, staff only). Null until the first check has run.
 */
export function useAmClockDrift(enabled = true) {
  return useQuery({
    queryKey: ['am-clock-drift-status'],
    enabled,
    staleTime: 300_000,
    retry: false,
    queryFn: async (): Promise<ClockDriftStatus | null> => {
      const { data, error } = await anyDb.rpc('get_am_clock_drift_status');
      if (error) throw new Error(error.message);
      const row = (Array.isArray(data) ? data[0] : data) as ClockDriftStatus | undefined;
      return row ?? null;
    },
  });
}
