import { Fragment, useMemo, useState } from 'react';
import { format } from 'date-fns';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  Sparkles,
  TrendingDown,
} from 'lucide-react';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatUGX } from '@/lib/rentCalculations';
import {
  usePayablesPredictiveForecast,
  type PayablesGranularity,
  type PayablesPredictivePeriod,
} from '@/hooks/usePayables';

const GRANULARITIES: { key: PayablesGranularity; label: string; defaultPeriods: number }[] = [
  { key: 'day', label: 'Daily', defaultPeriods: 30 },
  { key: 'week', label: 'Weekly', defaultPeriods: 26 },
  { key: 'month', label: 'Monthly', defaultPeriods: 12 },
  { key: 'quarter', label: 'Quarterly', defaultPeriods: 12 },
  { key: 'year', label: 'Yearly', defaultPeriods: 5 },
];

const HORIZONS: Record<PayablesGranularity, { value: number; label: string }[]> = {
  day: [
    { value: 1, label: 'Today' },
    { value: 2, label: 'Today + tomorrow' },
    { value: 7, label: 'Next 7 days' },
    { value: 14, label: 'Next 14 days' },
    { value: 30, label: 'Next 30 days' },
    { value: 60, label: 'Next 60 days' },
  ],
  week: [
    { value: 4, label: 'Next 4 weeks' },
    { value: 13, label: 'Next 13 weeks' },
    { value: 26, label: 'Next 26 weeks' },
    { value: 52, label: 'Next 52 weeks' },
  ],
  month: [
    { value: 1, label: 'This month' },
    { value: 3, label: 'Next 3 months' },
    { value: 6, label: 'Next 6 months' },
    { value: 12, label: 'Next 12 months' },
    { value: 24, label: 'Next 24 months' },
    { value: 36, label: 'Next 36 months' },
  ],
  quarter: [
    { value: 4, label: 'Next 4 quarters' },
    { value: 8, label: 'Next 8 quarters' },
    { value: 12, label: 'Next 12 quarters' },
    { value: 16, label: 'Next 16 quarters' },
  ],
  year: [
    { value: 2, label: 'Year 1 – 2' },
    { value: 3, label: 'Year 1 – 3' },
    { value: 4, label: 'Year 1 – 4' },
    { value: 5, label: 'Year 1 – 5' },
  ],
};

const QUALITY_STYLE: Record<string, string> = {
  high: 'bg-emerald-500/15 text-emerald-700',
  medium: 'bg-amber-500/15 text-amber-700',
  low: 'bg-orange-500/15 text-orange-700',
  insufficient: 'bg-muted text-muted-foreground',
};

const compact = (n: number) =>
  n >= 1_000_000_000
    ? `${(n / 1_000_000_000).toFixed(1)}B`
    : n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1_000
        ? `${(n / 1_000).toFixed(0)}K`
        : `${Math.round(n)}`;

function downloadCsv(name: string, rows: (string | number)[][]) {
  const csv = rows
    .map((r) =>
      r
        .map((c) => {
          const s = String(c ?? '');
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(',')
    )
    .join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export default function PredictivePayablesForecast() {
  const [granularity, setGranularity] = useState<PayablesGranularity>('month');
  const [periods, setPeriods] = useState(12);
  const [openPeriod, setOpenPeriod] = useState<number | null>(null);
  const [showStreams, setShowStreams] = useState(false);

  const q = usePayablesPredictiveForecast(granularity, periods);
  const data = q.data;

  const chartData = useMemo(() => {
    if (!data) return [];
    const hist = [...data.history].slice(-Math.min(periods, 12)).map((h) => ({
      label: h.label,
      actual: h.actual_amount,
      forecast: null as number | null,
      band: null as [number, number] | null,
    }));
    const fc = data.periods.map((p) => ({
      label: p.label,
      actual: null as number | null,
      forecast: p.forecast_amount,
      band: [p.low, p.high] as [number, number],
    }));
    return [...hist, ...fc];
  }, [data, periods]);

  const horizonTotal = useMemo(
    () => (data?.periods ?? []).reduce((s, p) => s + p.forecast_amount, 0),
    [data]
  );

  const changeGranularity = (g: PayablesGranularity) => {
    setGranularity(g);
    setPeriods(GRANULARITIES.find((x) => x.key === g)?.defaultPeriods ?? 12);
    setOpenPeriod(null);
  };

  const exportPeriods = () => {
    if (!data) return;
    downloadCsv(`payables-forecast-${granularity}-${data.as_at}.csv`, [
      [
        'Period',
        'Starts',
        'Ends',
        'Forecast UGX',
        'From existing obligations',
        'From new obligations',
        'Scheduled portion',
        'Low',
        'High',
        'Confidence',
        'Quality',
        'Why this quality',
      ],
      ...data.periods.map((p) => [
        p.label,
        p.period_start,
        p.period_end,
        p.forecast_amount,
        p.runoff_amount,
        p.new_origination_amount,
        p.scheduled_amount,
        p.low,
        p.high,
        p.confidence,
        p.quality,
        p.quality_reason ?? '',
      ]),
    ]);
  };

  const exportSources = () => {
    if (!data) return;
    downloadCsv(`payables-forecast-sources-${granularity}-${data.as_at}.csv`, [
      ['Period', 'Category', 'Payable type', 'Basis', 'Amount UGX', 'Existing', 'New obligations'],
      ...data.periods.flatMap((p) =>
        p.sources.map((s) => [
          p.label,
          s.category_label,
          s.product_label,
          s.basis,
          s.amount,
          s.runoff,
          s.new_origination,
        ])
      ),
    ]);
  };

  return (
    <Card className="border-primary/30 max-w-full">
      <CardContent className="p-3 sm:p-4 space-y-3 sm:space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-[10px] sm:text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Sparkles className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
              Predictive payables forecast
            </p>
            <p className="text-[9px] sm:text-[11px] text-muted-foreground">
              Modelled from real payment history · all forward amounts are estimates
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:items-end">
            <div className="inline-flex flex-wrap gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="Forecast interval">
              {GRANULARITIES.map((g) => (
                <button key={g.key} type="button" onClick={() => changeGranularity(g.key)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${granularity === g.key ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-primary/10 hover:text-primary'}`}>
                  {g.label}
                </button>
              ))}
            </div>
            <div className="inline-flex flex-wrap gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="Forecast period">
              {HORIZONS[granularity].map((h) => (
                <button key={h.value} type="button" onClick={() => setPeriods(h.value)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${periods === h.value ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-primary/10 hover:text-primary'}`}>
                  {h.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {q.isError && (
          <p className="text-[11px] sm:text-xs text-destructive">
            Could not load the forecast: {(q.error as Error)?.message}
          </p>
        )}

        {q.isLoading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : data ? (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
              <div className="rounded-xl bg-muted/50 px-2.5 py-2">
                <p className="text-[9px] sm:text-[10px] uppercase tracking-wider text-muted-foreground">
                  Actual recorded
                </p>
                <p className="text-xs sm:text-base font-bold font-mono tabular-nums truncate">
                  {formatUGX(data.actual.total)}
                </p>
                <p className="text-[9px] sm:text-[10px] text-muted-foreground">
                  {data.actual.item_count} open obligations
                </p>
              </div>
              <div className="rounded-xl bg-destructive/10 px-2.5 py-2">
                <p className="text-[9px] sm:text-[10px] uppercase tracking-wider text-destructive">
                  Overdue
                </p>
                <p className="text-xs sm:text-base font-bold font-mono tabular-nums truncate">
                  {formatUGX(data.actual.overdue)}
                </p>
                <p className="text-[9px] sm:text-[10px] text-muted-foreground">Past due date</p>
              </div>
              <div className="rounded-xl bg-emerald-500/10 px-2.5 py-2">
                <p className="text-[9px] sm:text-[10px] uppercase tracking-wider text-emerald-700">
                  Not yet due
                </p>
                <p className="text-xs sm:text-base font-bold font-mono tabular-nums truncate">
                  {formatUGX(data.actual.not_yet_due)}
                </p>
                <p className="text-[9px] sm:text-[10px] text-muted-foreground">On the books</p>
              </div>
              <div className="rounded-xl bg-primary/10 px-2.5 py-2">
                <p className="text-[9px] sm:text-[10px] uppercase tracking-wider text-primary flex items-center gap-1">
                  <TrendingDown className="h-2.5 w-2.5" /> Forecast (est.)
                </p>
                <p className="text-xs sm:text-base font-bold font-mono tabular-nums truncate">
                  {formatUGX(horizonTotal)}
                </p>
                <p className="text-[9px] sm:text-[10px] text-muted-foreground">
                  {data.periods.length} {granularity} period(s)
                </p>
              </div>
            </div>

            <div className="h-48 sm:h-56 lg:h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 9 }}
                    interval="preserveStartEnd"
                    minTickGap={16}
                  />
                  <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => compact(Number(v))} width={44} />
                  <Tooltip
                    formatter={(value: unknown, name) => {
                      if (Array.isArray(value)) {
                        return [`${compact(Number(value[0]))} – ${compact(Number(value[1]))}`, 'Range'];
                      }
                      return [formatUGX(Number(value ?? 0)), name === 'actual' ? 'Actual' : 'Forecast'];
                    }}
                    contentStyle={{ fontSize: 11 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Area
                    type="monotone"
                    dataKey="band"
                    name="Forecast range"
                    stroke="none"
                    fill="hsl(var(--primary))"
                    fillOpacity={0.12}
                  />
                  <Bar dataKey="actual" name="Actual paid" fill="hsl(var(--muted-foreground))" />
                  <Bar dataKey="forecast" name="Forecast (est.)" fill="hsl(var(--primary))" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div className="max-h-80 overflow-y-auto overflow-x-auto rounded-xl border border-border/60">
              <table className="w-full min-w-[320px] text-[10px] sm:text-xs">
                <thead className="bg-muted/50 sticky top-0 z-10">
                  <tr>
                    <th className="text-left px-2.5 py-1.5 font-medium">Period</th>
                    <th className="text-right px-2.5 py-1.5 font-medium">Forecast (est.)</th>
                    <th className="text-right px-2.5 py-1.5 font-medium hidden sm:table-cell">
                      Range
                    </th>
                    <th className="text-right px-2.5 py-1.5 font-medium">Quality</th>
                  </tr>
                </thead>
                <tbody>
                  {data.periods.map((p: PayablesPredictivePeriod) => {
                    const open = openPeriod === p.index;
                    return (
                      <Fragment key={p.index}>
                        <tr
                          className="border-t border-border/40 cursor-pointer hover:bg-muted/40"
                          onClick={() => setOpenPeriod(open ? null : p.index)}
                        >
                          <td className="px-2.5 py-1.5">
                            <span className="flex items-center gap-1">
                              {open ? (
                                <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                              ) : (
                                <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                              )}
                              <span className="font-medium truncate">{p.label}</span>
                              {p.is_partial_period && (
                                <Badge variant="outline" className="text-[8px] px-1 py-0 shrink-0">
                                  part
                                </Badge>
                              )}
                            </span>
                            <span className="block text-[9px] text-muted-foreground pl-4">
                              from {format(new Date(p.forecast_from), 'dd MMM yyyy')}
                            </span>
                          </td>
                          <td className="px-2.5 py-1.5 text-right font-mono tabular-nums font-semibold whitespace-nowrap">
                            {formatUGX(p.forecast_amount)}
                          </td>
                          <td className="px-2.5 py-1.5 text-right font-mono tabular-nums hidden sm:table-cell text-muted-foreground whitespace-nowrap">
                            {compact(p.low)} – {compact(p.high)}
                          </td>
                          <td className="px-2.5 py-1.5 text-right">
                            <Badge
                              className={`text-[8px] sm:text-[9px] px-1 py-0 border-0 whitespace-nowrap ${QUALITY_STYLE[p.quality] ?? ''}`}
                            >
                              {p.quality} · {Math.round(p.confidence * 100)}%
                            </Badge>
                          </td>
                        </tr>
                        {open && (
                          <tr className="bg-muted/20">
                            <td colSpan={4} className="px-2.5 py-2">
                              <div className="flex flex-wrap gap-1.5 mb-1.5">
                                <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                                  Existing obligations {formatUGX(p.runoff_amount)}
                                </Badge>
                                <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                                  New obligations {formatUGX(p.new_origination_amount)}
                                </Badge>
                                <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                                  Scheduled {formatUGX(p.scheduled_amount)}
                                </Badge>
                              </div>
                              {p.quality_reason && (
                                <p className="text-[9px] sm:text-[10px] text-muted-foreground flex items-start gap-1 mb-1.5">
                                  <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                                  Why {p.quality} confidence: {p.quality_reason}
                                </p>
                              )}
                              {p.sources.length === 0 ? (
                                <p className="text-[9px] sm:text-[10px] text-muted-foreground">
                                  No modelled outflow in this period.
                                </p>
                              ) : (
                                <div className="overflow-x-auto rounded-lg border border-border/60">
                                  <table className="w-full min-w-[240px] text-[10px] sm:text-xs">
                                    <thead className="bg-muted/40">
                                      <tr>
                                        <th className="text-left px-2.5 py-1.5 font-medium">
                                          Product
                                        </th>
                                        <th className="text-right px-2.5 py-1.5 font-medium">
                                          Estimated Amount
                                        </th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {p.sources.map((s) => (
                                        <tr
                                          key={`${s.category_key}:${s.product_key}:${s.basis}`}
                                          className="border-t border-border/40"
                                        >
                                          <td className="px-2.5 py-1.5">
                                            <span className="block truncate font-medium">
                                              {s.product_label}
                                            </span>
                                            <span className="flex items-center gap-1.5 text-[9px] text-muted-foreground">
                                              <span className="truncate">{s.category_label}</span>
                                              <Badge
                                                variant="outline"
                                                className="text-[8px] px-1 py-0 shrink-0"
                                              >
                                                {s.basis === 'scheduled' ? 'scheduled' : 'estimated'}
                                              </Badge>
                                            </span>
                                          </td>
                                          <td className="px-2.5 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                                            {formatUGX(s.amount)}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <button
              type="button"
              onClick={() => setShowStreams((s) => !s)}
              aria-expanded={showStreams}
              className="flex items-center gap-1.5 text-[10px] sm:text-xs text-muted-foreground hover:text-foreground"
            >
              {showStreams ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              Forecast quality by payable type ({data.streams.length} modelled)
            </button>

            {showStreams && (
              <div className="space-y-2">
                <div className="max-h-64 overflow-y-auto overflow-x-auto rounded-xl border border-border/60">
                  <table className="w-full min-w-[320px] text-[10px] sm:text-xs">
                    <thead className="bg-muted/50 sticky top-0 z-10">
                      <tr>
                        <th className="text-left px-2.5 py-1.5 font-medium">Payable type</th>
                        <th className="text-right px-2.5 py-1.5 font-medium">Typical / day</th>
                        <th className="text-right px-2.5 py-1.5 font-medium hidden sm:table-cell">
                          Trend / week
                        </th>
                        <th className="text-right px-2.5 py-1.5 font-medium hidden lg:table-cell">
                          New / day
                        </th>
                        <th className="text-right px-2.5 py-1.5 font-medium hidden lg:table-cell">
                          Paid
                        </th>
                        <th className="text-right px-2.5 py-1.5 font-medium">History</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.streams.map((s) => (
                        <tr
                          key={`${s.category_key}:${s.product_key}`}
                          className="border-t border-border/40"
                        >
                          <td className="px-2.5 py-1.5">
                            <span className="block truncate">{s.product_label}</span>
                            <span className="block text-[9px] text-muted-foreground truncate">
                              {s.category_label} ·{' '}
                              {s.insufficient_data
                                ? 'too little history'
                                : s.method.replace(/_/g, ' ')}
                            </span>
                          </td>
                          <td className="px-2.5 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                            {s.insufficient_data ? '—' : formatUGX(s.median_daily)}
                          </td>
                          <td className="px-2.5 py-1.5 text-right font-mono tabular-nums hidden sm:table-cell whitespace-nowrap">
                            {s.insufficient_data ? '—' : formatUGX(s.trend_per_week)}
                          </td>
                          <td className="px-2.5 py-1.5 text-right font-mono tabular-nums hidden lg:table-cell whitespace-nowrap">
                            {s.origination ? formatUGX(s.origination.daily_new_payables) : '—'}
                          </td>
                          <td className="px-2.5 py-1.5 text-right hidden lg:table-cell text-muted-foreground whitespace-nowrap">
                            {s.origination
                              ? `${Math.round(s.origination.payment_rate * 100)}% / ${Math.round(
                                  s.origination.term_days
                                )}d`
                              : '—'}
                          </td>
                          <td className="px-2.5 py-1.5 text-right text-muted-foreground whitespace-nowrap">
                            {s.sample_days}d of {s.lookback_days}d
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {data.scheduled_only_streams.length > 0 && (
                  <p className="text-[9px] sm:text-[10px] text-muted-foreground flex items-start gap-1">
                    <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                    <span>
                      Not enough payment history to model:{' '}
                      {data.scheduled_only_streams
                        .map((s) => `${s.product_label} (${formatUGX(s.outstanding)})`)
                        .join(', ')}
                      . These are shown from their contractual due dates only.
                    </span>
                  </p>
                )}

                {(data.origination_only_streams ?? []).length > 0 && (
                  <p className="text-[9px] sm:text-[10px] text-muted-foreground flex items-start gap-1">
                    <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                    <span>
                      No record of new obligations being created for:{' '}
                      {data.origination_only_streams
                        .map((s) => `${s.product_label} (${formatUGX(s.outstanding)})`)
                        .join(', ')}
                      . These forecast settlement of the existing book only.
                    </span>
                  </p>
                )}

                {/* Obligations with no due date and no daily amount — wallet
                    balances are payable on demand, so there is nothing to place
                    on a timeline. Disclosed rather than silently dropped. */}
                {!!data.unscheduled && data.unscheduled.items > 0 && (
                  <div className="rounded-lg border border-amber-500/40 bg-amber-50/60 dark:bg-amber-950/20 p-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold text-amber-800 dark:text-amber-300">
                          Payable on Demand / Not Scheduled
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          {data.unscheduled.items} item{data.unscheduled.items === 1 ? '' : 's'} with no
                          contractual due date. Included in Total Payables, excluded from the timeline
                          above — these are settled on request, not on a schedule.
                        </p>
                        {Object.keys(data.unscheduled.by_product ?? {}).length > 0 && (
                          <p className="text-[10px] text-muted-foreground mt-1">
                            {Object.entries(data.unscheduled.by_product)
                              .sort((a, b) => b[1] - a[1])
                              .map(([k, v]) => `${k.replace(/_/g, ' ')} ${formatUGX(v)}`)
                              .join(' · ')}
                          </p>
                        )}
                      </div>
                      <span className="font-mono text-xs font-bold shrink-0 text-amber-800 dark:text-amber-300">
                        {formatUGX(data.unscheduled.amount)}
                      </span>
                    </div>
                  </div>
                )}

                <p className="text-[9px] sm:text-[10px] text-muted-foreground">
                  {data.meta.method_note} History available: {data.meta.history_span_days ?? 0} days.
                  Any period ending beyond that span is extrapolation: it can never be shown as high
                  confidence, and periods more than twice the span away — including every future
                  year — are always flagged low and should be read as directional only.
                </p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
              <Button
                variant="outline"
                size="sm"
                className="h-9 sm:h-8 text-[11px] w-full sm:w-auto"
                onClick={exportPeriods}
              >
                <Download className="h-3.5 w-3.5 mr-1" /> Export periods
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-9 sm:h-8 text-[11px] w-full sm:w-auto"
                onClick={exportSources}
              >
                <Download className="h-3.5 w-3.5 mr-1" /> Export by source
              </Button>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
