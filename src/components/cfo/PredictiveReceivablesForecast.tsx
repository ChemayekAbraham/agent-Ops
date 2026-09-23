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
  ReferenceLine,
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

const HORIZONS: Record<ForecastGranularity, { value: number; label: string }[]> = {
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
  high: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  medium: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  low: 'bg-orange-500/15 text-orange-700 dark:text-orange-400',
  insufficient: 'bg-muted text-muted-foreground',
};

const QUALITY_BAR: Record<string, string> = {
  high: 'bg-emerald-500',
  medium: 'bg-amber-500',
  low: 'bg-orange-500',
  insufficient: 'bg-muted-foreground/40',
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

interface PredictiveReceivablesForecastProps {
  productLabel?: string;
  projectionAvailable?: boolean;
  /**
   * When set, the whole-book forecast is narrowed to this single product: every
   * period is rebuilt from only the modelled sources belonging to it, so a
   * product drill-down shows its own projection across the period choices.
   */
  filterProductKey?: string;
  filterCategoryKey?: string;
  /** The product's own recorded outstanding, shown instead of the book total. */
  actualTotal?: number;
  actualItemCount?: number;
}

export default function PredictiveReceivablesForecast({
  productLabel,
  projectionAvailable = true,
  filterProductKey,
  filterCategoryKey,
  actualTotal,
  actualItemCount,
}: PredictiveReceivablesForecastProps = {}) {
  const [granularity, setGranularity] = useState<ForecastGranularity>('month');
  const [periods, setPeriods] = useState(12);
  const [openPeriod, setOpenPeriod] = useState<number | null>(null);
  const [showStreams, setShowStreams] = useState(false);

  const q = useReceivablesPredictiveForecast(granularity, periods, projectionAvailable);
  const isFiltered = !!filterProductKey;

  /** Product-level view of the server forecast; identity when unfiltered. */
  const data = useMemo(() => {
    const raw = q.data;
    if (!raw || !filterProductKey) return raw;
    const matches = (s: { product_key: string; category_key: string }) =>
      s.product_key === filterProductKey &&
      (!filterCategoryKey || s.category_key === filterCategoryKey);
    return {
      ...raw,
      history: [],
      periods: raw.periods.map((p) => {
        const sources = p.sources.filter(matches);
        const amount = sources.reduce((s, x) => s + x.amount, 0);
        const ratio = p.forecast_amount > 0 ? amount / p.forecast_amount : 0;
        return {
          ...p,
          sources,
          forecast_amount: amount,
          runoff_amount: sources.reduce((s, x) => s + x.runoff, 0),
          new_origination_amount: sources.reduce((s, x) => s + x.new_origination, 0),
          scheduled_amount: sources
            .filter((x) => x.basis === 'scheduled')
            .reduce((s, x) => s + x.amount, 0),
          low: Math.round(p.low * ratio),
          high: Math.round(p.high * ratio),
        };
      }),
      streams: raw.streams.filter(matches),
      scheduled_only_streams: raw.scheduled_only_streams.filter((s) => matches(s)),
      origination_only_streams: raw.origination_only_streams.filter((s) => matches(s)),
      actual: {
        ...raw.actual,
        total: actualTotal ?? raw.actual.total,
        item_count: actualItemCount ?? raw.actual.item_count,
      },
    };
  }, [q.data, filterProductKey, filterCategoryKey, actualTotal, actualItemCount]);

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
    // Anchor the band on the last actual so the shaded range starts at the
    // boundary rather than floating in from the first forecast period.
    if (hist.length && fc.length) {
      const first = data.periods[0];
      hist[hist.length - 1] = {
        ...hist[hist.length - 1],
        band: [first.low, first.high] as [number, number],
      };
    }
    return [...hist, ...fc];
  }, [data, periods]);

  /** X value where actuals stop and estimates begin. */
  const boundaryLabel = useMemo(() => {
    if (!data) return null;
    const hist = [...data.history].slice(-Math.min(periods, 12));
    return hist.length ? hist[hist.length - 1].label : null;
  }, [data, periods]);

  const periodNoun = `${granularity}${(data?.periods.length ?? 0) === 1 ? '' : 's'}`;

  const horizonTotal = useMemo(
    () => (data?.periods ?? []).reduce((s, p) => s + p.forecast_amount, 0),
    [data]
  );

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
    <Card className="rounded-2xl shadow-sm max-w-full">
      <CardContent className="p-4 sm:p-5 space-y-4">
        {/* Header + controls */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Sparkles className="h-4 w-4 text-primary" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold tracking-tight">
                {productLabel ? `${productLabel} projection` : 'Predictive receivables forecast'}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {projectionAvailable
                  ? 'Modelled from real collection history · all forward amounts are estimates'
                  : 'No recognised receivable or sufficient projection data'}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1.5 sm:flex sm:items-center">
            <Select value={granularity} onValueChange={(v) => changeGranularity(v as ForecastGranularity)}>
              <SelectTrigger className="h-9 sm:h-8 w-full sm:w-[112px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GRANULARITIES.map((g) => (
                  <SelectItem key={g.key} value={g.key} className="text-xs">
                    {g.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={String(periods)} onValueChange={(v) => setPeriods(Number(v))}>
              <SelectTrigger className="h-9 sm:h-8 w-full sm:w-[156px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HORIZONS[granularity].map((h) => (
                  <SelectItem key={h.value} value={String(h.value)} className="text-xs">
                    {h.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {projectionAvailable && q.isError && (
          <p className="text-xs text-destructive">
            Could not load the forecast: {(q.error as Error)?.message}
          </p>
        )}

        {!projectionAvailable ? (
          <EmptyProjection granularity={granularity} periods={periods} />
        ) : q.isLoading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : data ? (
          <>
            {/* Actuals and forecast are different bases, so they are grouped
                separately rather than presented as four peer tiles. */}
            <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
              <div>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  On the books today
                </p>
                <div className={`grid grid-cols-1 gap-2 ${isFiltered ? '' : 'sm:grid-cols-3'}`}>
                  <Tile
                    label="Actual recorded"
                    value={formatUGX(data.actual.total)}
                    hint={`${data.actual.item_count} open item${data.actual.item_count === 1 ? '' : 's'}`}
                  />
                  {!isFiltered && (
                    <>
                      <Tile
                        label="Overdue"
                        value={formatUGX(data.actual.overdue)}
                        hint="Past due date"
                        labelTone="text-destructive"
                        valueTone="text-destructive"
                      />
                      <Tile
                        label="Not yet due"
                        value={formatUGX(data.actual.not_yet_due)}
                        hint="On the books"
                        labelTone="text-emerald-700 dark:text-emerald-500"
                      />
                    </>
                  )}
                </div>
              </div>
              <div className="lg:w-64">
                <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-primary">
                  <TrendingUp className="h-3 w-3" /> Forecast · estimate
                </p>
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
                  <p className="font-mono text-lg font-bold tabular-nums truncate">
                    {formatUGX(horizonTotal)}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    across {data.periods.length} {periodNoun}
                  </p>
                </div>
              </div>
            </div>

            {/* Chart: history actuals + forecast with band */}
            <div className="h-56 sm:h-64 lg:h-80 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11 }}
                    interval="preserveStartEnd"
                    minTickGap={16}
                  />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => compact(Number(v))} width={48} />
                  <Tooltip
                    formatter={(value: unknown, name) => {
                      if (Array.isArray(value)) {
                        return [`${compact(Number(value[0]))} – ${compact(Number(value[1]))}`, 'Range'];
                      }
                      return [formatUGX(Number(value ?? 0)), name === 'actual' ? 'Actual' : 'Forecast'];
                    }}
                    contentStyle={{ fontSize: 12, borderRadius: 10 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Area
                    type="monotone"
                    dataKey="band"
                    name="Forecast range"
                    stroke="hsl(var(--primary))"
                    strokeOpacity={0.35}
                    strokeWidth={1}
                    fill="hsl(var(--primary))"
                    fillOpacity={0.18}
                  />
                  <Bar
                    dataKey="actual"
                    name="Actual collected"
                    fill="hsl(var(--muted-foreground))"
                    radius={[3, 3, 0, 0]}
                  />
                  <Bar
                    dataKey="forecast"
                    name="Forecast (est.)"
                    fill="hsl(var(--primary))"
                    fillOpacity={0.75}
                    radius={[3, 3, 0, 0]}
                  />
                  {/* Without this the eye cannot tell recorded from estimated. */}
                  {boundaryLabel && (
                    <ReferenceLine
                      x={boundaryLabel}
                      stroke="hsl(var(--foreground))"
                      strokeOpacity={0.45}
                      strokeDasharray="4 3"
                      label={{
                        value: 'estimates →',
                        position: 'insideTopRight',
                        fontSize: 10,
                        fill: 'hsl(var(--muted-foreground))',
                      }}
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Period table with drill-down by source */}
            <div className="max-h-80 overflow-y-auto overflow-x-auto rounded-xl border border-border/60">
              <table className="w-full min-w-[320px] text-xs">
                <thead className="bg-muted/50 sticky top-0 z-10">
                  <tr>
                    <th className="text-left px-2.5 py-1.5 font-medium">Period</th>
                    <th className="text-right px-2.5 py-1.5 font-medium">Forecast (est.)</th>
                    <th className="text-right px-2.5 py-1.5 font-medium hidden sm:table-cell">
                      Range · UGX
                    </th>
                    <th className="text-right px-2.5 py-1.5 font-medium">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {data.periods.map((p: PredictivePeriod) => {
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
                                <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">
                                  part
                                </Badge>
                              )}
                            </span>
                            <span className="block text-[11px] text-muted-foreground pl-4">
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
                            <QualityCell quality={p.quality} confidence={p.confidence} />
                          </td>
                        </tr>
                        {open && (
                          <tr className="bg-muted/20">
                            <td colSpan={4} className="px-2.5 py-2">
                              <div className="flex flex-wrap gap-1.5 mb-1.5">
                                <Badge variant="outline" className="text-[11px] px-1.5 py-0">
                                  Existing book {formatUGX(p.runoff_amount)}
                                </Badge>
                                <Badge variant="outline" className="text-[11px] px-1.5 py-0">
                                  New business {formatUGX(p.new_origination_amount)}
                                </Badge>
                                <Badge variant="outline" className="text-[11px] px-1.5 py-0">
                                  Scheduled {formatUGX(p.scheduled_amount)}
                                </Badge>
                              </div>
                              {p.quality_reason && (
                                <p className="text-[11px] text-muted-foreground flex items-start gap-1 mb-1.5">
                                  <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                                  Why {p.quality} confidence: {p.quality_reason}
                                </p>
                              )}
                              {p.sources.length === 0 ? (
                                <p className="text-[11px] text-muted-foreground">
                                  No modelled inflow in this period.
                                </p>
                              ) : (
                                <div className="overflow-x-auto rounded-lg border border-border/60">
                                  <table className="w-full min-w-[240px] text-xs">
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
                                            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                              <span className="truncate">{s.category_label}</span>
                                              <Badge
                                                variant="outline"
                                                className="text-[10px] px-1 py-0 shrink-0"
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

            {/* Model transparency */}
            <button
              type="button"
              onClick={() => setShowStreams((s) => !s)}
              aria-expanded={showStreams}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              {showStreams ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              Forecast quality by business line ({data.streams.length} modelled)
            </button>

            {showStreams && (
              <div className="space-y-2">
                <div className="max-h-64 overflow-y-auto overflow-x-auto rounded-xl border border-border/60">
                  <table className="w-full min-w-[320px] text-xs">
                    <thead className="bg-muted/50 sticky top-0 z-10">
                      <tr>
                        <th className="text-left px-2.5 py-1.5 font-medium">Business line</th>
                        <th className="text-right px-2.5 py-1.5 font-medium">Typical / day</th>
                        <th className="text-right px-2.5 py-1.5 font-medium hidden sm:table-cell">
                          Trend / week
                        </th>
                        <th className="text-right px-2.5 py-1.5 font-medium hidden md:table-cell">
                          New / day
                        </th>
                        <th className="text-right px-2.5 py-1.5 font-medium hidden md:table-cell">
                          Collected
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
                            <span className="block text-[11px] text-muted-foreground truncate">
                              {s.category_label} ·{' '}
                              {s.insufficient_data ? 'too little history' : s.method.replace(/_/g, ' ')}
                            </span>
                          </td>
                          <td className="px-2.5 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                            {s.insufficient_data ? '—' : formatUGX(s.median_daily)}
                          </td>
                          <td className="px-2.5 py-1.5 text-right font-mono tabular-nums hidden sm:table-cell whitespace-nowrap">
                            {s.insufficient_data ? '—' : formatUGX(s.trend_per_week)}
                          </td>
                          <td className="px-2.5 py-1.5 text-right font-mono tabular-nums hidden md:table-cell whitespace-nowrap">
                            {s.origination ? formatUGX(s.origination.daily_new_receivables) : '—'}
                          </td>
                          <td className="px-2.5 py-1.5 text-right hidden md:table-cell text-muted-foreground whitespace-nowrap">
                            {s.origination
                              ? `${Math.round(s.origination.collection_rate * 100)}% / ${Math.round(
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
                  <p className="text-[11px] text-muted-foreground flex items-start gap-1">
                    <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                    <span>
                      Not enough collection history to model:{' '}
                      {data.scheduled_only_streams
                        .map((s) => `${s.product_label} (${formatUGX(s.outstanding)})`)
                        .join(', ')}
                      . These are shown from their contractual due dates only.
                    </span>
                  </p>
                )}

                {(data.origination_only_streams ?? []).length > 0 && (
                  <p className="text-[11px] text-muted-foreground flex items-start gap-1">
                    <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                    <span>
                      No record of new business being written for:{' '}
                      {data.origination_only_streams
                        .map((s) => `${s.product_label} (${formatUGX(s.outstanding)})`)
                        .join(', ')}
                      . These forecast the run-off of the existing book only — no new receivables are
                      assumed.
                    </span>
                  </p>
                )}

                {/* Receivables the forecast cannot place on a timeline. Shown so
                    the gap between the book and the forecast is visible rather
                    than silent — the amount is still in Total Receivables. */}
                {!!data.unscheduled && data.unscheduled.items > 0 && (
                  <div className="rounded-lg border border-amber-500/40 bg-amber-50/60 dark:bg-amber-950/20 p-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold text-amber-800 dark:text-amber-300">
                          Unscheduled / Not in Forecast
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          {data.unscheduled.items} item{data.unscheduled.items === 1 ? '' : 's'} with no
                          contractual date and no daily amount to project from. Included in Total
                          Receivables, excluded from the timeline above.
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

                <p className="text-[11px] text-muted-foreground">
                  {data.meta.method_note} History available:{' '}
                  {data.meta.history_span_days ?? 0} days. Any period ending beyond that span is
                  extrapolation: it can never be shown as high confidence, and periods more than
                  twice the span away — including every future year — are always flagged low and
                  should be read as directional only.
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
              <p className="text-[11px] text-muted-foreground">
                CSV includes the run-off / new-business / scheduled split, the range and the
                reason for each period's confidence — more detail than the table shows.
              </p>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Sparkles className="h-5 w-5 text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground">
              No forecast available yet — there is not enough collection history to model.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyProjection({
  granularity,
  periods,
}: {
  granularity: ForecastGranularity;
  periods: number;
}) {
  const periodNoun = `${granularity}${periods === 1 ? '' : 's'}`;

  return (
    <>
      <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            On the books today
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Tile label="Actual recorded" value={formatUGX(0)} hint="0 open items" />
            <Tile label="Overdue" value={formatUGX(0)} hint="Past due date" />
            <Tile label="Not yet due" value={formatUGX(0)} hint="On the books" />
          </div>
        </div>
        <div className="lg:w-64">
          <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-primary">
            <TrendingUp className="h-3 w-3" /> Forecast · estimate
          </p>
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
            <p className="font-mono text-lg font-bold tabular-nums">{formatUGX(0)}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              no projection across {periods} {periodNoun}
            </p>
          </div>
        </div>
      </div>

      <div className="flex h-56 w-full items-center justify-center rounded-xl border border-border/60 bg-muted/10 sm:h-64 lg:h-80">
        <div className="text-center">
          <TrendingUp className="mx-auto h-5 w-5 text-muted-foreground/40" />
          <p className="mt-2 text-xs font-medium text-muted-foreground">UGX 0</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">No projection available</p>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border/60">
        <table className="w-full min-w-[320px] text-xs">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-2.5 py-1.5 text-left font-medium">Period</th>
              <th className="px-2.5 py-1.5 text-right font-medium">Forecast (est.)</th>
              <th className="hidden px-2.5 py-1.5 text-right font-medium sm:table-cell">Range · UGX</th>
              <th className="px-2.5 py-1.5 text-right font-medium">Confidence</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-border/40">
              <td className="px-2.5 py-3 text-muted-foreground">No projection</td>
              <td className="px-2.5 py-3 text-right font-mono font-semibold tabular-nums">{formatUGX(0)}</td>
              <td className="hidden px-2.5 py-3 text-right font-mono text-muted-foreground sm:table-cell">—</td>
              <td className="px-2.5 py-3 text-right">
                <Badge className={`border-0 px-1.5 py-0 text-[10px] ${QUALITY_STYLE.insufficient}`}>
                  no projection
                </Badge>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

/** One actual-basis figure. */
function Tile({ label, value, hint, labelTone, valueTone }: {
  label: string;
  value: string;
  hint: string;
  labelTone?: string;
  valueTone?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className={`text-[10px] font-semibold uppercase tracking-[0.07em] ${labelTone ?? 'text-muted-foreground'}`}>
        {label}
      </p>
      <p className={`mt-1 font-mono text-base font-bold tabular-nums truncate ${valueTone ?? ''}`}>
        {value}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * Quality and confidence are one measure, not two: the SQL caps confidence at a
 * per-quality ceiling (high .95 / medium .6 / low .35 / insufficient .05), so
 * "low · 35%" read as two independent signals. Shown here as a single graded
 * chip with the percentage as a meter beneath it.
 */
function QualityCell({ quality, confidence }: { quality: string; confidence: number }) {
  const pct = Math.round(confidence * 100);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Badge className={`text-[10px] px-1.5 py-0 border-0 whitespace-nowrap ${QUALITY_STYLE[quality] ?? ''}`}>
        {quality}
      </Badge>
      <span
        className="flex h-1 w-14 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${pct}% confidence`}
        title={`${pct}% confidence`}
      >
        <span className={`h-full rounded-full ${QUALITY_BAR[quality] ?? 'bg-muted-foreground'}`} style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

