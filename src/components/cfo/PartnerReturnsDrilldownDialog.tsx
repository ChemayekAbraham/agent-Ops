import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';

export type DrilldownMetric =
  | 'forecast'
  | 'actual'
  | 'receivable'
  | 'topups'
  | 'promissory'
  | 'compounding';

export const METRIC_LABELS: Record<DrilldownMetric, string> = {
  forecast: 'Returns payable forecast',
  actual: 'Returns actually paid',
  receivable: 'Receivable from partners',
  topups: 'Top-ups received',
  promissory: 'Promissory notes receivable',
  compounding: 'Compounding (reinvested)',
};

const SOURCE_LABELS: Record<string, string> = {
  investor_portfolios: 'Partner portfolio',
  general_ledger: 'Posted payment',
  promissory_notes: 'Promissory note',
};

interface DetailRow {
  record_id: string;
  subject_id: string | null;
  name: string;
  detail: string;
  amount: number;
  occurred_on: string;
  status: string;
  source: string;
}

interface DetailPayload {
  metric: string;
  bucket: string;
  period: string;
  count: number;
  shown: number;
  total: number;
  truncated: boolean;
  rows: DetailRow[];
}

export interface DrilldownTarget {
  period: string;
  periodLabel: string;
  metric: DrilldownMetric;
  bucket: 'day' | 'week' | 'month';
}

export function PartnerReturnsDrilldownDialog({
  target,
  onClose,
}: {
  target: DrilldownTarget | null;
  onClose: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['partner-returns-drilldown', target?.period, target?.metric, target?.bucket],
    enabled: !!target,
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc(
        'get_partner_ops_returns_forecast_detail',
        {
          p_period: target!.period,
          p_metric: target!.metric,
          p_bucket: target!.bucket,
          p_limit: 300,
        },
      );
      if (error) throw error;
      return data as DetailPayload;
    },
  });

  const rows = data?.rows ?? [];

  return (
    <Dialog open={!!target} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">
            {target ? METRIC_LABELS[target.metric] : ''} — {target?.periodLabel}
          </DialogTitle>
          <DialogDescription className="text-[11px]">
            Every record behind this figure, largest first.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : error ? (
          <p className="text-xs text-rose-600">
            Could not load the records behind this figure. Please try again.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap rounded-xl border border-border p-3">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Total</p>
                <p className="text-sm font-bold font-mono tabular-nums">
                  {formatUGX(Number(data?.total ?? 0))}
                </p>
              </div>
              <Badge variant="outline" className="text-[10px]">
                {Number(data?.count ?? 0)} record{Number(data?.count ?? 0) === 1 ? '' : 's'}
                {data?.truncated ? ` · showing the largest ${data?.shown}` : ''}
              </Badge>
            </div>

            {rows.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No records fall in this period for this figure.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                      <th className="py-2 pr-3 font-semibold">Who</th>
                      <th className="py-2 pr-3 font-semibold">Record</th>
                      <th className="py-2 pr-3 font-semibold">Date</th>
                      <th className="py-2 font-semibold text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={`${r.record_id}-${i}`} className="border-t border-border/60 align-top">
                        <td className="py-2 pr-3 font-medium">
                          {r.name}
                          <span className="block text-[10px] text-muted-foreground">
                            {SOURCE_LABELS[r.source] ?? r.source} · {r.status}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground max-w-[22rem]">
                          <span className="line-clamp-3">{r.detail}</span>
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap">{r.occurred_on}</td>
                        <td className="py-2 text-right font-mono tabular-nums font-semibold">
                          {formatUGX(Number(r.amount))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
