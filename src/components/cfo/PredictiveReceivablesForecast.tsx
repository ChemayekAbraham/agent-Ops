import { Fragment, useMemo, useState } from 'react';
import { format } from 'date-fns';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  Sparkles,
  TrendingUp,
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
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useReceivablesPredictiveForecast,
  type ForecastGranularity,
  type PredictivePeriod,
} from '@/hooks/useReceivables';

const GRANULARITIES: { key: ForecastGranularity; label: string; defaultPeriods: number }[] = [
  { key: 'day', label: 'Daily', defaultPeriods: 30 },
  { key: 'week', label: 'Weekly', defaultPeriods: 26 },
  { key: 'month', label: 'Monthly', defaultPeriods: 12 },
  { key: 'quarter', label: 'Quarterly', defaultPeriods: 12 },
  { key: 'year', label: 'Yearly', defaultPeriods: 5 },
];

const HORIZONS: Record<ForecastGranularity, { value: number; label: string; short: string }[]> = {
  day: [
    { value: 1, label: 'Today', short: 'Today' },
    { value: 2, label: 'Today + tomorrow', short: '2D' },
    { value: 7, label: 'Next 7 days', short: '7D' },
    { value: 14, label: 'Next 14 days', short: '14D' },
    { value: 30, label: 'Next 30 days', short: '30D' },
    { value: 60, label: 'Next 60 days', short: '60D' },
  ],
  week: [
    { value: 4, label: 'Next 4 weeks', short: '4W' },
    { value: 13, label: 'Next 13 weeks', short: '13W' },
    { value: 26, label: 'Next 26 weeks', short: '26W' },
    { value: 52, label: 'Next 52 weeks', short: '52W' },
  ],
  month: [
    { value: 1, label: 'This month', short: '1M' },
    { value: 3, label: 'Next 3 months', short: '3M' },
    { value: 6, label: 'Next 6 months', short: '6M' },
    { value: 12, label: 'Next 12 months', short: '12M' },
    { value: 24, label: 'Next 24 months', short: '24M' },
    { value: 36, label: 'Next 36 months', short: '36M' },
  ],
  quarter: [
    { value: 4, label: 'Next 4 quarters', short: '4Q' },
    { value: 8, label: 'Next 8 quarters', short: '8Q' },
    { value: 12, label: 'Next 12 quarters', short: '12Q' },
    { value: 16, label: 'Next 16 quarters', short: '16Q' },
  ],
  year: [
    { value: 2, label: 'Year 1 – 2', short: 'Y2' },
    { value: 3, label: 'Year 1 – 3', short: 'Y3' },
    { value: 4, label: 'Year 1 – 4', short: 'Y4' },
    { value: 5, label: 'Year 1 – 5', short: 'Y5' },
  ],
};

const QUALITY_STYLE: Record<string, { bar: string; text: string }> = {
  high: { bar: 'bg-success', text: 'text-success' },
  medium: { bar: 'bg-warning', text: 'text-warning' },
  low: { bar: 'bg-destructive', text: 'text-destructive' },
  insufficient: { bar: 'bg-muted-foreground/40', text: 'text-muted-foreground' },
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

export default function PredictiveReceivablesForecast() {
  const [granularity, setGranularity] = useState<ForecastGranularity>('month');
  const [periods, setPeriods] = useState(12);
  const [openPeriod, setOpenPeriod] = useState<number | null>(null);
  const [showStreams, setShowStreams] = useState(false);

  const q = useReceivablesPredictiveForecast(granularity, periods);
  const data = q.data;

  const chartData = useMemo(() => {
    if (!data) return [];
    const hist = [...data.history]
      .slice(-Math.min(periods, 12))
      .map((h) => ({
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

  const horizonLabel =
    HORIZONS[granularity].find((h) => h.value === periods)?.label ?? `${periods} periods`;

  const changeGranularity = (g: ForecastGranularity) => {
    setGranularity(g);
    setPeriods(GRANULARITIES.find((x) => x.key === g)?.defaultPeriods ?? 12);
    setOpenPeriod(null);
  };

  const exportPeriods = () => {
    if (!data) return;
    downloadCsv(`receivables-forecast-${granularity}-${data.as_at}.csv`, [
      [
        'Period',
        'Starts',
        'Ends',
        'Forecast UGX',
        'From existing book',
        'From new business',
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
    downloadCsv(`receivables-forecast-sources-${granularity}-${data.as_at}.csv`, [
      ['Period', 'Category', 'Product', 'Basis', 'Amount UGX', 'Existing book', 'New business'],
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
    <Card className="overflow-hidden rounded-2xl border-report-grid p-0 shadow-sm">
      {/* ---------- Header band ---------- */}
      <header className="bg-report-ink px-4 py-4 sm:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 font-mono text-base font-bold tracking-tight text-report-ink-foreground sm:text-lg">
              <Sparkles className="h-4 w-4 shrink-0 text-report-ink-muted" />
              Predictive Receivables Forecast
            </h3>
            <p className="mt-0.5 text-[11px] text-report-ink-muted">
              Modelled from real collection history · all forward amounts are estimates
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            {/* Granularity segmented control */}
            <div
              role="tablist"
              aria-label="Forecast granularity"
              className="-mx-1 flex items-center gap-1 overflow-x-auto rounded-lg border border-report-ink-foreground/10 bg-report-ink-foreground/10 p-1 px-1"
            >
              {GRANULARITIES.map((g) => {
                const active = g.key === granularity;
                return (
                  <button
                    key={g.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => changeGranularity(g.key)}
                    className={cn(
                      'shrink-0 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                      active
                        ? 'bg-primary text-primary-foreground shadow-sm'
                        : 'text-report-ink-foreground/60 hover:text-report-ink-foreground'
                    )}
                  >
                    {g.label}
                  </button>
                );
              })}
            </div>

            <span className="hidden h-8 w-px bg-report-ink-foreground/20 sm:block" />

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={exportPeriods}
                disabled={!data}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[11px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                <Download className="h-3.5 w-3.5" /> Export periods
              </button>
              <button
                type="button"
                onClick={exportSources}
                disabled={!data}
                className="inline-flex items-center gap-1.5 rounded-lg border border-report-ink-foreground/20 px-3 py-2 text-[11px] font-semibold text-report-ink-foreground transition-colors hover:bg-report-ink-foreground/10 disabled:opacity-50"
              >
                <Download className="h-3.5 w-3.5" /> By source
              </button>
            </div>
          </div>
        </div>
      </header>

      {q.isError && (
        <p className="border-b border-report-grid bg-destructive/10 px-4 py-3 text-[11px] text-destructive sm:px-6">
          Could not load the forecast: {(q.error as Error)?.message}
        </p>
      )}

      {q.isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : data ? (
        <>
          {/* ---------- KPI strip ---------- */}
          <div className="grid grid-cols-2 gap-px bg-report-grid lg:grid-cols-4">
            <div className="bg-card p-4 sm:p-5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Actual recorded
              </p>
              <p className="mt-1.5 break-words font-mono text-lg font-bold tabular-nums sm:text-xl">
                {formatUGX(data.actual.total)}
              </p>
              <p className="mt-1.5 text-[10px] text-muted-foreground">
                {data.actual.item_count} open items
              </p>
            </div>
            <div className="bg-card p-4 sm:p-5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-destructive">
                Overdue
              </p>
              <p className="mt-1.5 break-words font-mono text-lg font-bold tabular-nums text-destructive sm:text-xl">
                {formatUGX(data.actual.overdue)}
              </p>
              <p className="mt-1.5 text-[10px] text-muted-foreground">Past due date</p>
            </div>
            <div className="bg-card p-4 sm:p-5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Not yet due
              </p>
              <p className="mt-1.5 break-words font-mono text-lg font-bold tabular-nums sm:text-xl">
                {formatUGX(data.actual.not_yet_due)}
              </p>
              <p className="mt-1.5 text-[10px] text-muted-foreground">On the books</p>
            </div>
            <div className="bg-primary/5 p-4 sm:p-5">
              <div className="flex items-start justify-between gap-2">
                <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
                  <TrendingUp className="h-3 w-3" /> Forecast (est.)
                </p>
                <Badge className="shrink-0 border-0 bg-primary/15 px-1.5 py-0 text-[9px] font-bold uppercase text-primary">
                  {horizonLabel}
                </Badge>
              </div>
              <p className="mt-1.5 break-words font-mono text-lg font-bold tabular-nums text-primary sm:text-xl">
                {formatUGX(horizonTotal)}
              </p>
              <p className="mt-1.5 text-[10px] text-primary/70">
                {data.periods.length} {granularity} period(s) · estimate
              </p>
            </div>
          </div>

          {/* ---------- Chart band ---------- */}
          <div className="border-b border-report-grid bg-card px-4 py-5 sm:px-6">
            <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h4 className="text-[11px] font-bold uppercase tracking-widest text-foreground">
                Actual collections vs forecast
              </h4>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span className="h-2.5 w-2.5 rounded-sm bg-report-ink" /> Actual collected
                </span>
                <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span className="h-2.5 w-2.5 rounded-sm bg-primary" /> Forecast (est.)
                </span>
                <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span className="h-2.5 w-6 rounded-sm border border-dashed border-primary/40 bg-primary/10" />{' '}
                  Forecast range
                </span>
              </div>
            </div>

            <div className="h-56 w-full rounded-xl bg-report-surface/40 p-2 sm:h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-report-grid" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 9 }}
                    interval="preserveStartEnd"
                    tickMargin={6}
                  />
                  <YAxis
                    tick={{ fontSize: 9 }}
                    tickFormatter={(v) => compact(Number(v))}
                    width={44}
                  />
                  <Tooltip
                    formatter={(value: unknown, name) => {
                      if (Array.isArray(value)) {
                        return [
                          `${compact(Number(value[0]))} – ${compact(Number(value[1]))}`,
                          'Range',
                        ];
                      }
                      return [
                        formatUGX(Number(value ?? 0)),
                        name === 'actual' ? 'Actual' : 'Forecast',
                      ];
                    }}
                    contentStyle={{ fontSize: 11, borderRadius: 8 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 9 }} />
                  <Area
                    type="monotone"
                    dataKey="band"
                    name="Forecast range"
                    stroke="none"
                    fill="hsl(var(--primary))"
                    fillOpacity={0.12}
                  />
                  <Bar dataKey="actual" name="Actual collected" fill="hsl(var(--report-ink))" />
                  <Bar dataKey="forecast" name="Forecast (est.)" fill="hsl(var(--primary))" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* ---------- Period table ---------- */}
          <div className="max-h-[26rem] overflow-y-auto">
            <table className="w-full text-left">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-report-grid bg-report-surface">
                  <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-foreground sm:px-6">
                    Forecast period
                  </th>
                  <th className="px-3 py-3 text-right text-[10px] font-bold uppercase tracking-wider text-foreground">
                    Projected (UGX)
                  </th>
                  <th className="hidden px-3 py-3 text-right text-[10px] font-bold uppercase tracking-wider text-foreground sm:table-cell">
                    Range (low/high)
                  </th>
                  <th className="px-4 py-3 text-right text-[10px] font-bold uppercase tracking-wider text-foreground sm:px-6">
                    Model quality
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.periods.map((p: PredictivePeriod) => {
                  const open = openPeriod === p.index;
                  const qs = QUALITY_STYLE[p.quality] ?? QUALITY_STYLE.insufficient;
                  return (
                    <Fragment key={p.index}>
                      <tr
                        className={cn(
                          'cursor-pointer border-b border-report-grid/60 transition-colors hover:bg-report-surface/60',
                          open && 'bg-report-surface/60'
                        )}
                        onClick={() => setOpenPeriod(open ? null : p.index)}
                      >
                        <td className="px-4 py-3 sm:px-6">
                          <span className="flex items-center gap-1.5">
                            {open ? (
                              <ChevronDown className="h-3.5 w-3.5 text-primary" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                            <span className="text-xs font-semibold">{p.label}</span>
                            {p.is_partial_period && (
                              <Badge variant="outline" className="px-1 py-0 text-[9px]">
                                part
                              </Badge>
                            )}
                          </span>
                          <span className="mt-0.5 block pl-5 text-[9px] text-muted-foreground">
                            from {format(new Date(p.forecast_from), 'dd MMM yyyy')}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-xs font-bold tabular-nums">
                          {formatUGX(p.forecast_amount)}
                        </td>
                        <td className="hidden px-3 py-3 text-right font-mono text-[11px] tabular-nums text-muted-foreground sm:table-cell">
                          {compact(p.low)} — {compact(p.high)}
                        </td>
                        <td className="px-4 py-3 sm:px-6">
                          <div className="flex items-center justify-end gap-2">
                            <div className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-report-grid sm:block">
                              <div
                                className={cn('h-full rounded-full', qs.bar)}
                                style={{
                                  width: `${Math.max(4, Math.round(p.confidence * 100))}%`,
                                }}
                              />
                            </div>
                            <span
                              className={cn(
                                'shrink-0 text-[10px] font-bold uppercase tabular-nums',
                                qs.text
                              )}
                            >
                              {p.quality} · {Math.round(p.confidence * 100)}%
                            </span>
                          </div>
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-b border-report-grid/60 bg-report-surface/40">
                          <td colSpan={4} className="px-4 py-3 sm:px-6">
                            <div className="mb-2 flex flex-wrap gap-1.5">
                              <Badge variant="outline" className="px-1.5 py-0 text-[9px]">
                                Existing book {formatUGX(p.runoff_amount)}
                              </Badge>
                              <Badge variant="outline" className="px-1.5 py-0 text-[9px]">
                                New business {formatUGX(p.new_origination_amount)}
                              </Badge>
                              <Badge variant="outline" className="px-1.5 py-0 text-[9px]">
                                Scheduled {formatUGX(p.scheduled_amount)}
                              </Badge>
                            </div>
                            {p.quality_reason && (
                              <p className="mb-2 flex items-start gap-1 text-[10px] text-muted-foreground">
                                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                                Why {p.quality} confidence: {p.quality_reason}
                              </p>
                            )}
                            {p.sources.length === 0 ? (
                              <p className="text-[10px] text-muted-foreground">
                                No modelled inflow in this period.
                              </p>
                            ) : (
                              <div className="rounded-lg border border-report-grid bg-card">
                                {p.sources.map((s) => (
                                  <div
                                    key={`${s.category_key}:${s.product_key}:${s.basis}`}
                                    className="flex items-center justify-between gap-2 border-b border-report-grid/60 px-2.5 py-1.5 last:border-0"
                                  >
                                    <span className="flex min-w-0 items-center gap-1.5">
                                      <span className="truncate text-[11px]">{s.product_label}</span>
                                      <span className="hidden text-[9px] text-muted-foreground sm:inline">
                                        {s.category_label}
                                      </span>
                                      <Badge
                                        variant="outline"
                                        className="shrink-0 px-1 py-0 text-[9px]"
                                      >
                                        {s.basis === 'scheduled' ? 'scheduled' : 'estimated'}
                                      </Badge>
                                    </span>
                                    <span className="shrink-0 font-mono text-[11px] tabular-nums">
                                      {formatUGX(s.amount)}
                                    </span>
                                  </div>
                                ))}
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

          {/* ---------- Methodology drawer ---------- */}
          <div className="border-t border-report-grid bg-card px-4 py-3 sm:px-6">
            <button
              type="button"
              onClick={() => setShowStreams((s) => !s)}
              className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-primary hover:text-primary/80"
            >
              {showStreams ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              Forecast quality by business line ({data.streams.length} modelled)
            </button>

            {showStreams && (
              <div className="mt-3 space-y-2">
                <div className="max-h-64 overflow-auto rounded-xl border border-report-grid">
                  <table className="w-full text-left text-[11px]">
                    <thead className="sticky top-0 bg-report-surface">
                      <tr>
                        <th className="px-2.5 py-2 text-[9px] font-bold uppercase tracking-wider">
                          Business line
                        </th>
                        <th className="px-2.5 py-2 text-right text-[9px] font-bold uppercase tracking-wider">
                          Typical / day
                        </th>
                        <th className="hidden px-2.5 py-2 text-right text-[9px] font-bold uppercase tracking-wider sm:table-cell">
                          Trend / week
                        </th>
                        <th className="hidden px-2.5 py-2 text-right text-[9px] font-bold uppercase tracking-wider md:table-cell">
                          New / day
                        </th>
                        <th className="hidden px-2.5 py-2 text-right text-[9px] font-bold uppercase tracking-wider md:table-cell">
                          Collected
                        </th>
                        <th className="px-2.5 py-2 text-right text-[9px] font-bold uppercase tracking-wider">
                          History
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.streams.map((s) => (
                        <tr
                          key={`${s.category_key}:${s.product_key}`}
                          className="border-t border-report-grid/60"
                        >
                          <td className="px-2.5 py-2">
                            <span className="block truncate font-medium">{s.product_label}</span>
                            <span className="block text-[9px] text-muted-foreground">
                              {s.category_label} ·{' '}
                              {s.insufficient_data
                                ? 'too little history'
                                : s.method.replace(/_/g, ' ')}
                            </span>
                          </td>
                          <td className="px-2.5 py-2 text-right font-mono tabular-nums">
                            {s.insufficient_data ? '—' : formatUGX(s.median_daily)}
                          </td>
                          <td className="hidden px-2.5 py-2 text-right font-mono tabular-nums sm:table-cell">
                            {s.insufficient_data ? '—' : formatUGX(s.trend_per_week)}
                          </td>
                          <td className="hidden px-2.5 py-2 text-right font-mono tabular-nums md:table-cell">
                            {s.origination ? formatUGX(s.origination.daily_new_receivables) : '—'}
                          </td>
                          <td className="hidden px-2.5 py-2 text-right text-muted-foreground md:table-cell">
                            {s.origination
                              ? `${Math.round(s.origination.collection_rate * 100)}% / ${Math.round(
                                  s.origination.term_days
                                )}d`
                              : '—'}
                          </td>
                          <td className="px-2.5 py-2 text-right text-muted-foreground">
                            {s.sample_days}d of {s.lookback_days}d
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {data.scheduled_only_streams.length > 0 && (
                  <p className="flex items-start gap-1 text-[10px] text-muted-foreground">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    Not enough collection history to model:{' '}
                    {data.scheduled_only_streams
                      .map((s) => `${s.product_label} (${formatUGX(s.outstanding)})`)
                      .join(', ')}
                    . These are shown from their contractual due dates only.
                  </p>
                )}

                {(data.origination_only_streams ?? []).length > 0 && (
                  <p className="flex items-start gap-1 text-[10px] text-muted-foreground">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    No record of new business being written for:{' '}
                    {data.origination_only_streams
                      .map((s) => `${s.product_label} (${formatUGX(s.outstanding)})`)
                      .join(', ')}
                    . These forecast the run-off of the existing book only — no new receivables are
                    assumed.
                  </p>
                )}

                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  {data.meta.method_note} History available: {data.meta.history_span_days ?? 0} days.
                  Any period ending beyond that span is extrapolation: it can never be shown as high
                  confidence, and periods more than twice the span away — including every future year
                  — are always flagged low and should be read as directional only.
                </p>
              </div>
            )}
          </div>

          {/* ---------- Footer: horizon control ---------- */}
          <div className="flex flex-col gap-3 border-t border-report-grid bg-report-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div className="flex items-center gap-3">
              <span className="hidden shrink-0 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground sm:inline">
                Projection horizon
              </span>
              <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1">
                {HORIZONS[granularity].map((h) => {
                  const active = h.value === periods;
                  return (
                    <button
                      key={h.value}
                      type="button"
                      onClick={() => {
                        setPeriods(h.value);
                        setOpenPeriod(null);
                      }}
                      aria-pressed={active}
                      title={h.label}
                      className={cn(
                        'shrink-0 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors',
                        active
                          ? 'border-transparent bg-report-ink text-report-ink-foreground shadow-sm'
                          : 'border-primary/20 text-muted-foreground hover:bg-card hover:text-foreground'
                      )}
                    >
                      {h.short}
                    </button>
                  );
                })}
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground">
              As at {format(new Date(data.as_at), 'dd MMM yyyy')} · {horizonLabel}
            </p>
          </div>
        </>
      ) : null}
    </Card>
  );
}
