import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, ChevronDown } from 'lucide-react';
import { format, startOfWeek, endOfWeek } from 'date-fns';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(n));

interface Portfolio {
  id: string;
  investment_amount: number;
  roi_percentage: number;
  next_roi_date: string | null;
  status: string;
  investor_id: string | null;
}

export function ROIPayableForecast() {
  const [expanded, setExpanded] = useState(true);

  const { data, isLoading } = useQuery({
    queryKey: ['roi-payable-forecast'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('investor_portfolios')
        .select('id, investment_amount, roi_percentage, next_roi_date, status, investor_id')
        .eq('status', 'active')
        .not('next_roi_date', 'is', null);
      if (error) throw error;
      return (data || []) as Portfolio[];
    },
  });

  const calcROI = (p: Portfolio) => (p.investment_amount * p.roi_percentage) / 100;

  // Group active portfolios into the calendar week their next ROI falls due.
  const weekMap = new Map<string, { start: Date; due: Date; investors: Set<string>; amount: number }>();
  (data || []).forEach((p) => {
    if (!p.next_roi_date) return;
    const d = new Date(p.next_roi_date);
    const start = startOfWeek(d, { weekStartsOn: 1 });
    const key = start.toISOString().slice(0, 10);
    const bucket = weekMap.get(key) || {
      start,
      due: endOfWeek(d, { weekStartsOn: 1 }),
      investors: new Set<string>(),
      amount: 0,
    };
    bucket.investors.add(p.investor_id || p.id);
    bucket.amount += calcROI(p);
    weekMap.set(key, bucket);
  });

  const rows = Array.from(weekMap.values())
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, 8);

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <p className="text-sm font-bold tracking-tight">ROI Payable Forecast</p>
        <button
          type="button"
          onClick={() => setExpanded((o) => !o)}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ROI Payable Forecast`}
          className="text-muted-foreground hover:text-foreground shrink-0"
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {expanded && (
        <div className="px-4 pb-4">
          {isLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : rows.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">No returns scheduled.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <th className="text-left font-medium uppercase tracking-wider text-[10px] text-muted-foreground px-3 py-2">Due Week</th>
                    <th className="text-left font-medium uppercase tracking-wider text-[10px] text-muted-foreground px-3 py-2">Due Date</th>
                    <th className="text-left font-medium uppercase tracking-wider text-[10px] text-muted-foreground px-3 py-2">Investors</th>
                    <th className="text-right font-medium uppercase tracking-wider text-[10px] text-muted-foreground px-3 py-2">Amount (UGX)</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.start.toISOString()} className="border-b border-border/60 last:border-0">
                      <td className="px-3 py-2 whitespace-nowrap text-foreground">Week of {format(r.start, 'dd MMM yyyy')}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-foreground">{format(r.due, 'EEE, dd MMM yyyy')}</td>
                      <td className="px-3 py-2 tabular-nums text-foreground">{r.investors.size}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-foreground">UGX {fmt(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
