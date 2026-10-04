/**
 * Read-only "Collections Forecast" panel for Tenant Ops → Tenant Products &
 * Services. Projects future rent-payment collections from historical trends
 * only (server-side RPC `get_payment_collections_projection`). No payment,
 * wallet, ledger, or accounting logic lives here.
 */
import { useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import { Download, Info, Loader2, RefreshCw, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import {
  usePaymentCollectionsProjection,
  type ProjectionGranularity, type ProjectionQuality,
} from '@/hooks/usePaymentCollectionsProjection';
import { downloadCollectionsProjectionPdf } from '@/lib/collectionsProjectionPdf';

const ugx = (n: unknown) => `UGX ${Math.round(Number(n) || 0).toLocaleString()}`;
const compact = (n: unknown) => {
  const v = Math.round(Number(n) || 0);
  if (Math.abs(v) >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return String(v);
};

const GRAN_OPTIONS: Array<{ value: ProjectionGranularity; label: string }> = [
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
  { value: 'quarter', label: 'Quarterly' },
  { value: 'year', label: 'Yearly' },
];

const HORIZON_PRESETS: Array<{ label: string; granularity: ProjectionGranularity; periods: number }> = [
  { label: 'Next 7 days', granularity: 'day', periods: 7 },
  { label: 'Next month', granularity: 'day', periods: 30 },
  { label: 'Next 3 months', granularity: 'week', periods: 13 },
  { label: 'Next 6 months', granularity: 'month', periods: 6 },
  { label: 'Next 12 months', granularity: 'month', periods: 12 },
  { label: 'Next 2 years', granularity: 'year', periods: 2 },
  { label: 'Next 3 years', granularity: 'year', periods: 3 },
];

const QUALITY_STYLE: Record<ProjectionQuality, string> = {
  high: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  medium: 'border-amber-200 bg-amber-50 text-amber-700',
  low: 'border-slate-200 bg-slate-50 text-slate-500',
};
const QUALITY_LABEL: Record<ProjectionQuality, string> = {
  high: 'High confidence',
  medium: 'Medium',
  low: 'Low confidence',
};

/** Aggregate the daily history into buckets of the active granularity so
 *  actuals and forecasts can share one chart axis. */
function bucketHistory(
  history: Array<{ date: string; amount: number }>,
  gran: ProjectionGranularity,
  buckets: number,
) {
  const perDays = gran === 'day' ? 1 : gran === 'week' ? 7 : gran === 'month' ? 30 : gran === 'quarter' ? 91 : 365;
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const out: Array<{ label: string; amount: number }> = [];
  for (let i = sorted.length - 1; i >= 0 && out.length < buckets; i -= perDays) {
    let sum = 0;
    let end = sorted[i].date;
    for (let j = i; j > i - perDays && j >= 0; j--) sum += Number(sorted[j].amount) || 0;
    out.unshift({ label: end.slice(5), amount: sum });
  }
  return out;
}

export function CollectionsProjectionPanel() {
  const [granularity, setGranularity] = useState<ProjectionGranularity>('month');
  const [periods, setPeriods] = useState(6);
  const [horizonLabel, setHorizonLabel] = useState('Next 6 months');
  const [exporting, setExporting] = useState(false);

  const { data, isLoading, isFetching, error, refetch } =
    usePaymentCollectionsProjection(granularity, periods);

  const chartData = useMemo(() => {
    if (!data) return [];
    const actual = bucketHistory(data.history, granularity, data.periods.length);
    const rows: Array<Record<string, unknown>> = actual.map((a) => ({
      label: a.label,
      actual: a.amount,
      forecast: null,
      high: null,
      low: null,
    }));
    for (const p of data.periods) {
      rows.push({
        label: p.label,
        actual: null,
        forecast: p.forecast_amount,
        high: p.high,
        low: p.low,
      });
    }
    return rows;
  }, [data, granularity]);

  const totals = useMemo(() => {
    if (!data) return null;
    const forecast = data.periods.reduce((s, p) => s + p.forecast_amount, 0);
    const low = data.periods.reduce((s, p) => s + p.low, 0);
    const high = data.periods.reduce((s, p) => s + p.high, 0);
    const worst: ProjectionQuality = data.periods.some((p) => p.quality === 'low')
      ? 'low' : data.periods.some((p) => p.quality === 'medium') ? 'medium' : 'high';
    return { forecast, low, high, worst };
  }, [data]);

  const onExport = async () => {
    if (!data) return;
    setExporting(true);
    try {
      await downloadCollectionsProjectionPdf({ projection: data, horizonLabel });
      toast.success('Forecast PDF downloaded');
    } catch (e: any) {
      toast.error(e?.message || 'Could not generate the PDF');
    } finally {
      setExporting(false);
    }
  };

  return (
  <Card className="border-border/60">
    <CardHeader className="px-5 py-4 pb-2">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-sm sm:text-base">
              <TrendingUp className="h-4 w-4 text-emerald-600 shrink-0" />
              Collections Forecast
              <Badge variant="outline" className="border-amber-200 bg-amber-50 text-[10px] text-amber-700">
                Forecast — estimated
              </Badge>
            </CardTitle>
            <p className="mt-1 text-[11px] sm:text-xs text-muted-foreground max-w-2xl">
              Projected rent-payment collections from historical payment trends only. Not a guarantee of future collections.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" className="h-8 text-[11px]" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
              Refresh
            </Button>
            <Button variant="outline" size="sm" className="h-8 text-[11px]" onClick={onExport} disabled={!data || exporting}>
              {exporting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}
              Export PDF
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 px-5 pb-5 pt-0">
        {/* Horizon presets */}
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Horizon</span>
          {HORIZON_PRESETS.map((h) => (
            <Button
              key={h.label}
              size="sm"
              variant={horizonLabel === h.label ? 'default' : 'outline'}
              className="h-7 px-2.5 text-[10px]"
              onClick={() => { setGranularity(h.granularity); setPeriods(h.periods); setHorizonLabel(h.label); }}
            >
              {h.label}
            </Button>
          ))}
          <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">View</span>
          {GRAN_OPTIONS.map((g) => (
            <Button
              key={g.value}
              size="sm"
              variant={granularity === g.value ? 'default' : 'outline'}
              className="h-7 px-2.5 text-[10px]"
              onClick={() => { setGranularity(g.value); setHorizonLabel('Custom'); }}
            >
              {g.label}
            </Button>
          ))}
        </div>

        {isLoading ? (
          <Skeleton className="h-[300px] rounded-xl" />
        ) : error ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-[12px] text-destructive">
            {(error as Error).message}
          </div>
        ) : data && totals ? (
          <>
            <Separator />

            {/* KPI row */}
            <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
              <div className="rounded-xl border border-border/60 bg-card p-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Expected collections
                </div>
                <div className="mt-1.5 text-base sm:text-lg font-bold font-mono tabular-nums">{ugx(totals.forecast)}</div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">{horizonLabel}</div>
              </div>
              <div className="rounded-xl border border-border/60 bg-card p-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Likely range
                </div>
                <div className="mt-1.5 text-base sm:text-lg font-bold font-mono tabular-nums">{compact(totals.low)} – {compact(totals.high)}</div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">low – high band</div>
              </div>
              <div className="rounded-xl border border-border/60 bg-card p-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Daily level
                </div>
                <div className="mt-1.5 text-base sm:text-lg font-bold font-mono tabular-nums">{ugx(data.meta.level_daily)}</div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  trend {data.meta.trend_weekly >= 0 ? '+' : '−'}{compact(Math.abs(data.meta.trend_weekly))} / week
                </div>
              </div>
              <div className="rounded-xl border border-border/60 bg-card p-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Confidence
                </div>
                <div className="mt-1.5">
                  <Badge variant="outline" className={cn('text-[10px]', QUALITY_STYLE[totals.worst])}>
                    {QUALITY_LABEL[totals.worst]}
                  </Badge>
                </div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  {data.meta.history_span_days} days of history
                </div>
              </div>
            </div>

            {totals.worst === 'low' && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-800">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Part of this horizon extends beyond the {data.meta.history_span_days}-day observed history.
                Those periods are low-confidence trend extrapolations — treat them as indicative, not commitments.
              </div>
            )}

            {/* Actual vs forecast chart */}
            <div className="h-[240px] w-full rounded-xl border border-border/60 bg-card p-2.5">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis tickFormatter={compact} tick={{ fontSize: 10 }} width={48} />
                  <Tooltip formatter={(v: any) => (v == null ? '—' : ugx(v))} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="actual" name="Actual collections" fill="#0ea5e9" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="forecast" name="Forecast (estimated)" fill="#a78bfa" radius={[3, 3, 0, 0]} />
                  <Line dataKey="high" name="High band" stroke="#10b981" strokeDasharray="4 4" dot={false} />
                  <Line dataKey="low" name="Low band" stroke="#f59e0b" strokeDasharray="4 4" dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Period table */}
            <div className="overflow-x-auto rounded-xl border border-border/60">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-border/60 bg-muted/50 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 font-semibold">Period</th>
                    <th className="px-3 py-2 font-semibold text-right">Forecast</th>
                    <th className="px-3 py-2 font-semibold text-right">Low</th>
                    <th className="px-3 py-2 font-semibold text-right">High</th>
                    <th className="px-3 py-2 font-semibold">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {data.periods.map((p) => (
                    <tr key={p.period_start} className="border-b border-border/40 last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="px-3 py-2">{p.label}</td>
                      <td className="px-3 py-2 text-right font-semibold font-mono tabular-nums">{ugx(p.forecast_amount)}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground font-mono tabular-nums">{ugx(p.low)}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground font-mono tabular-nums">{ugx(p.high)}</td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className={cn('text-[10px]', QUALITY_STYLE[p.quality])}>
                          {QUALITY_LABEL[p.quality]}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Method disclosure */}
            <details className="rounded-xl border border-border/60 bg-muted/20 p-3 text-[11px] text-muted-foreground">
              <summary className="cursor-pointer text-[11px] font-semibold text-foreground list-none flex items-center gap-1.5">
                <Info className="h-3.5 w-3.5" />
                How this is calculated
              </summary>
              <div className="mt-2.5 space-y-1 pl-5">
                <p>{data.meta.method}</p>
                <p>
                  History: {data.meta.history_span_days} days ({data.meta.observed_days} days with collections),
                  as at {data.meta.as_at} (East Africa Time).
                </p>
                <p>
                  Confidence ceilings: High 0.85 · Medium 0.6 · Low 0.35. Projections beyond the observed
                  history span are always Low confidence.
                </p>
              </div>
            </details>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default CollectionsProjectionPanel;
