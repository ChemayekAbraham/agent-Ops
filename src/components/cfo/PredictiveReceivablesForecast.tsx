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
    <Card className="border-primary/30">
      <CardContent className="p-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Sparkles className="h-3 w-3" />
              Predictive receivables forecast
            </p>
            <p className="text-[9px] text-muted-foreground">
              Modelled from real collection history · all forward amounts are estimates
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <Select value={granularity} onValueChange={(v) => changeGranularity(v as ForecastGranularity)}>
              <SelectTrigger className="h-7 w-[104px] text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GRANULARITIES.map((g) => (
                  <SelectItem key={g.key} value={g.key} className="text-[11px]">
                    {g.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={String(periods)} onValueChange={(v) => setPeriods(Number(v))}>
              <SelectTrigger className="h-7 w-[148px] text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HORIZONS[granularity].map((h) => (
                  <SelectItem key={h.value} value={String(h.value)} className="text-[11px]">
                    {h.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {q.isError && (
          <p className="text-[11px] text-destructive">
            Could not load the forecast: {(q.error as Error)?.message}
          </p>
        )}

        {q.isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : data ? (
          <>
            {/* Actual vs overdue vs forecast */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              <div className="rounded-lg bg-muted/50 px-2 py-1.5">
                <p className="text-[8px] uppercase tracking-wider text-muted-foreground">
                  Actual recorded
                </p>
                <p className="text-[11px] font-bold font-mono truncate">
                  {formatUGX(data.actual.total)}
                </p>
                <p className="text-[8px] text-muted-foreground">{data.actual.item_count} open items</p>
              </div>
              <div className="rounded-lg bg-destructive/10 px-2 py-1.5">
                <p className="text-[8px] uppercase tracking-wider text-destructive">Overdue</p>
                <p className="text-[11px] font-bold font-mono truncate">
                  {formatUGX(data.actual.overdue)}
                </p>
                <p className="text-[8px] text-muted-foreground">Past due date</p>
              </div>
              <div className="rounded-lg bg-emerald-500/10 px-2 py-1.5">
                <p className="text-[8px] uppercase tracking-wider text-emerald-700">Not yet due</p>
                <p className="text-[11px] font-bold font-mono truncate">
                  {formatUGX(data.actual.not_yet_due)}
                </p>
                <p className="text-[8px] text-muted-foreground">On the books</p>
              </div>
              <div className="rounded-lg bg-primary/10 px-2 py-1.5">
                <p className="text-[8px] uppercase tracking-wider text-primary flex items-center gap-1">
                  <TrendingUp className="h-2.5 w-2.5" /> Forecast (est.)
                </p>
                <p className="text-[11px] font-bold font-mono truncate">{formatUGX(horizonTotal)}</p>
                <p className="text-[8px] text-muted-foreground">
                  {data.periods.length} {granularity} period(s)
                </p>
              </div>
            </div>

            {/* Chart: history actuals + forecast with band */}
            <div className="h-52 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                  <XAxis dataKey="label" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => compact(Number(v))} width={40} />
                  <Tooltip
                    formatter={(value: unknown, name) => {
                      if (Array.isArray(value)) {
                        return [`${compact(Number(value[0]))} – ${compact(Number(value[1]))}`, 'Range'];
                      }
                      return [formatUGX(Number(value ?? 0)), name === 'actual' ? 'Actual' : 'Forecast'];
                    }}
                    contentStyle={{ fontSize: 11 }}
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
                  <Bar dataKey="actual" name="Actual collected" fill="hsl(var(--muted-foreground))" />
                  <Bar dataKey="forecast" name="Forecast (est.)" fill="hsl(var(--primary))" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Period table with drill-down by source */}
            <div className="max-h-72 overflow-y-auto rounded-lg border border-border/60">
              <table className="w-full text-[10px]">
                <thead className="bg-muted/50 sticky top-0">
                  <tr>
                    <th className="text-left px-2 py-1 font-medium">Period</th>
                    <th className="text-right px-2 py-1 font-medium">Forecast (est.)</th>
                    <th className="text-right px-2 py-1 font-medium hidden sm:table-cell">Range</th>
                    <th className="text-right px-2 py-1 font-medium">Quality</th>
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
                          <td className="px-2 py-1">
                            <span className="flex items-center gap-1">
                              {open ? (
                                <ChevronDown className="h-3 w-3 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="h-3 w-3 text-muted-foreground" />
                              )}
                              <span className="font-medium">{p.label}</span>
                              {p.is_partial_period && (
                                <Badge variant="outline" className="text-[8px] px-1 py-0">
                                  part
                                </Badge>
                              )}
                            </span>
                            <span className="block text-[8px] text-muted-foreground pl-4">
                              from {format(new Date(p.forecast_from), 'dd MMM yyyy')}
                            </span>
                          </td>
                          <td className="px-2 py-1 text-right font-mono font-semibold">
                            {formatUGX(p.forecast_amount)}
                          </td>
                          <td className="px-2 py-1 text-right font-mono hidden sm:table-cell text-muted-foreground">
                            {compact(p.low)} – {compact(p.high)}
                          </td>
                          <td className="px-2 py-1 text-right">
                            <Badge
                              className={`text-[8px] px-1 py-0 border-0 ${QUALITY_STYLE[p.quality] ?? ''}`}
                            >
                              {p.quality} · {Math.round(p.confidence * 100)}%
                            </Badge>
                          </td>
                        </tr>
                        {open && (
                          <tr className="bg-muted/20">
                            <td colSpan={4} className="px-2 py-1.5">
                              <div className="flex flex-wrap gap-1.5 mb-1">
                                <Badge variant="outline" className="text-[8px] px-1 py-0">
                                  Existing book {formatUGX(p.runoff_amount)}
                                </Badge>
                                <Badge variant="outline" className="text-[8px] px-1 py-0">
                                  New business {formatUGX(p.new_origination_amount)}
                                </Badge>
                                <Badge variant="outline" className="text-[8px] px-1 py-0">
                                  Scheduled {formatUGX(p.scheduled_amount)}
                                </Badge>
                              </div>
                              {p.quality_reason && (
                                <p className="text-[9px] text-muted-foreground flex items-start gap-1 mb-1">
                                  <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                                  Why {p.quality} confidence: {p.quality_reason}
                                </p>
                              )}
                              {p.sources.length === 0 ? (
                                <p className="text-[9px] text-muted-foreground">
                                  No modelled inflow in this period.
                                </p>
                              ) : (
                                p.sources.map((s) => (
                                  <div
                                    key={`${s.category_key}:${s.product_key}:${s.basis}`}
                                    className="flex items-center justify-between gap-2 border-b border-border/30 last:border-0 py-0.5"
                                  >
                                    <span className="min-w-0 flex items-center gap-1.5">
                                      <span className="truncate text-[10px]">{s.product_label}</span>
                                      <span className="text-[8px] text-muted-foreground">
                                        {s.category_label}
                                      </span>
                                      <Badge
                                        variant="outline"
                                        className="text-[8px] px-1 py-0 shrink-0"
                                      >
                                        {s.basis === 'scheduled' ? 'scheduled' : 'estimated'}
                                      </Badge>
                                    </span>
                                    <span className="font-mono text-[10px] shrink-0">
                                      {formatUGX(s.amount)}
                                    </span>
                                  </div>
                                ))
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
              className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground"
            >
              {showStreams ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              Forecast quality by business line ({data.streams.length} modelled)
            </button>

            {showStreams && (
              <div className="space-y-1.5">
                <div className="max-h-56 overflow-y-auto rounded-lg border border-border/60">
                  <table className="w-full text-[10px]">
                    <thead className="bg-muted/50 sticky top-0">
                      <tr>
                        <th className="text-left px-2 py-1 font-medium">Business line</th>
                        <th className="text-right px-2 py-1 font-medium">Typical / day</th>
                        <th className="text-right px-2 py-1 font-medium hidden sm:table-cell">
                          Trend / week
                        </th>
                        <th className="text-right px-2 py-1 font-medium">History</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.streams.map((s) => (
                        <tr
                          key={`${s.category_key}:${s.product_key}`}
                          className="border-t border-border/40"
                        >
                          <td className="px-2 py-1">
                            <span className="block truncate">{s.product_label}</span>
                            <span className="block text-[8px] text-muted-foreground">
                              {s.category_label} ·{' '}
                              {s.insufficient_data ? 'too little history' : s.method.replace(/_/g, ' ')}
                            </span>
                          </td>
                          <td className="px-2 py-1 text-right font-mono">
                            {s.insufficient_data ? '—' : formatUGX(s.median_daily)}
                          </td>
                          <td className="px-2 py-1 text-right font-mono hidden sm:table-cell">
                            {s.insufficient_data ? '—' : formatUGX(s.trend_per_week)}
                          </td>
                          <td className="px-2 py-1 text-right text-muted-foreground">
                            {s.sample_days}d of {s.lookback_days}d
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {data.scheduled_only_streams.length > 0 && (
                  <p className="text-[9px] text-muted-foreground flex items-start gap-1">
                    <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                    Not enough collection history to model:{' '}
                    {data.scheduled_only_streams
                      .map((s) => `${s.product_label} (${formatUGX(s.outstanding)})`)
                      .join(', ')}
                    . These are shown from their contractual due dates only.
                  </p>
                )}

                <p className="text-[9px] text-muted-foreground">
                  {data.meta.method_note} History available:{' '}
                  {data.meta.history_span_days ?? 0} days. Horizons beyond one year are extrapolation
                  and are flagged low quality.
                </p>
              </div>
            )}

            <div className="flex flex-wrap gap-1.5">
              <Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={exportPeriods}>
                <Download className="h-3 w-3 mr-1" /> Export periods
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={exportSources}>
                <Download className="h-3 w-3 mr-1" /> Export by source
              </Button>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
