import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface DailyCashFlowPoint {
  date: string;   // YYYY-MM-DD (Uganda local day)
  label: string;  // MM-DD
  inflow: number;
  outflow: number;
}

export interface SevenDayCashFlow {
  days: DailyCashFlowPoint[];
  totalInflow: number;
  totalOutflow: number;
  netFlow: number;
}

/**
 * Daily cash inflows / outflows for the last 7 days.
 *
 * Aggregation happens server-side in `get_cfo_daily_cash_flow` because the
 * ledger produces thousands of legs per day — a client-side read silently
 * truncated at the Data API row cap and dropped whole days from the chart.
 *
 * The RPC groups on `transaction_date` (the posting date, not `created_at`),
 * buckets by Africa/Kampala (EAT / UTC+3) calendar day, filters to the same
 * classifications used by the CFO cash widgets (production + legacy_real),
 * and always returns every day in the window — zero-activity days come back
 * as 0 / 0 so they render as zero-height bars instead of vanishing.
 */
export function useCFO7DayCashFlow() {
  return useQuery<SevenDayCashFlow>({
    queryKey: ['cfo-overview-7day-cashflow'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_cfo_daily_cash_flow', { p_days: 7 });
      if (error) throw error;

      const days: DailyCashFlowPoint[] = ((data as any[]) || []).map((r) => {
        const key = String(r.day).slice(0, 10);
        return {
          date: key,
          label: key.slice(5),
          inflow: Number(r.inflow) || 0,
          outflow: Number(r.outflow) || 0,
        };
      });

      const totalInflow = days.reduce((s, d) => s + d.inflow, 0);
      const totalOutflow = days.reduce((s, d) => s + d.outflow, 0);

      return { days, totalInflow, totalOutflow, netFlow: totalInflow - totalOutflow };
    },
    staleTime: 60_000,
  });
}
