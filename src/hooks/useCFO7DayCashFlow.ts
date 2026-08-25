import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface DailyCashFlowPoint {
  date: string;   // YYYY-MM-DD
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
 * Reads the exact same ledger source and filters used by "Today's Money Flow"
 * (general_ledger, direction cash_in / cash_out, production + legacy_real).
 */
export function useCFO7DayCashFlow() {
  return useQuery<SevenDayCashFlow>({
    queryKey: ['cfo-overview-7day-cashflow'],
    queryFn: async () => {
      // Build the 7-day window (today inclusive), local calendar days
      const days: DailyCashFlowPoint[] = [];
      const buckets = new Map<string, DailyCashFlowPoint>();
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const point: DailyCashFlowPoint = { date: key, label: key.slice(5), inflow: 0, outflow: 0 };
        days.push(point);
        buckets.set(key, point);
      }

      const startStr = days[0].date;
      const endStr = days[days.length - 1].date;

      const { data: entries, error } = await supabase
        .from('general_ledger')
        .select('amount, direction, created_at')
        .gte('created_at', `${startStr}T00:00:00`)
        .lt('created_at', `${endStr}T23:59:59.999`)
        .in('classification', ['production', 'legacy_real']);

      if (error) throw error;

      ((entries as any[]) || []).forEach((e) => {
        const created = new Date(e.created_at);
        const key = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}-${String(created.getDate()).padStart(2, '0')}`;
        const bucket = buckets.get(key);
        if (!bucket) return;
        const amt = Number(e.amount) || 0;
        if (e.direction === 'cash_in') bucket.inflow += amt;
        else if (e.direction === 'cash_out') bucket.outflow += amt;
      });

      const totalInflow = days.reduce((s, d) => s + d.inflow, 0);
      const totalOutflow = days.reduce((s, d) => s + d.outflow, 0);

      return { days, totalInflow, totalOutflow, netFlow: totalInflow - totalOutflow };
    },
    staleTime: 60_000,
  });
}
