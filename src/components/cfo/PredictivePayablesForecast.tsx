import { Fragment, useMemo, useState } from 'react';
import { format } from 'date-fns';
import {
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  Sparkles,
  TrendingDown,
} from 'lucide-react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatUGX } from '@/lib/rentCalculations';
import {
  usePayablesPredictiveForecast,
  type PayablesGranularity,
  type PayablesPredictivePeriod,
} from '@/hooks/usePayables';

const PERIOD_PRESETS: { label: string; granularity: PayablesGranularity; periods: number }[] = [
  { label: 'Next 7 days', granularity: 'day', periods: 7 },
  { label: 'Next 14 days', granularity: 'day', periods: 14 },
  { label: 'Next 30 days', granularity: 'day', periods: 30 },
  { label: 'Next 90 days', granularity: 'week', periods: 13 },
  { label: '1 year', granularity: 'month', periods: 12 },
  { label: '2 years', granularity: 'month', periods: 24 },
  { label: '3 years', granularity: 'month', periods: 36 },
  { label: '5 years', granularity: 'year', periods: 5 },
];


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
  const [granularity, setGranularity] = useState<PayablesGranularity>('day');
  const [periods, setPeriods] = useState(7);
  const [activePreset, setActivePreset] = useState('Next 7 days');
  const [openPeriod, setOpenPeriod] = useState<number | null>(null);

  const q = usePayablesPredictiveForecast(granularity, periods);
  const data = q.data;

  // Behavior projection = average actually paid in past periods (same weekday for daily view)
  const historyProjection = useMemo(() => {
    const h = data?.history ?? [];
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const overall = avg(h.map((x) => x.actual_amount));
    const map = new Map<number, number>();
    (data?.periods ?? []).forEach((p) => {
      if (granularity === 'day') {
        const dow = new Date(p.period_start).getUTCDay();
        const same = h.filter((x) => new Date(x.period_start).getUTCDay() === dow).map((x) => x.actual_amount);
        map.set(p.index, Math.round(same.length ? avg(same) : overall));
      } else {
        map.set(p.index, Math.round(overall));
      }
    });
    return map;
  }, [data, granularity]);

  const chartData = useMemo(() => {
    if (!data) return [];
    const hist = [...data.history].slice(-Math.min(periods, 12)).map((h) => ({
      label: h.label,
      actual: h.actual_amount,
      forecast: null as number | null,
      ideal: null as number | null,
    }));
    const fc = data.periods.map((p) => ({
      label: p.label,
      actual: null as number | null,
      forecast: historyProjection.get(p.index) ?? 0,
      ideal: p.scheduled_amount,
    }));
    return [...hist, ...fc];
  }, [data, periods, historyProjection]);

  const horizonTotal = useMemo(
    () => (data?.periods ?? []).reduce((s, p) => s + (historyProjection.get(p.index) ?? 0), 0),
    [data, historyProjection]
  );

  const idealTotal = useMemo(
    () => (data?.periods ?? []).reduce((s, p) => s + p.scheduled_amount, 0),
    [data]
  );

  const selectPreset = (preset: (typeof PERIOD_PRESETS)[number]) => {
    setGranularity(preset.granularity);
    setPeriods(preset.periods);
    setActivePreset(preset.label);
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
            <div className="inline-flex flex-wrap gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="Forecast period">
              {PERIOD_PRESETS.map((preset) => (
                <button key={preset.label} type="button" onClick={() => selectPreset(preset)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${activePreset === preset.label ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-primary/10 hover:text-primary'}`}>
                  {preset.label}
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
              <div className="rounded-xl bg-primary/10 px-2.5 py-2">
                <p className="text-[9px] sm:text-[10px] uppercase tracking-wider text-primary flex items-center gap-1">
                  <TrendingDown className="h-2.5 w-2.5" /> Behavior projection
                </p>
                <p className="text-xs sm:text-base font-bold font-mono tabular-nums truncate">
                  {formatUGX(horizonTotal)}
                </p>
                <p className="text-[9px] sm:text-[10px] text-muted-foreground">
                  Based on past payment history
                </p>
              </div>
              <div className="rounded-xl bg-muted/50 px-2.5 py-2">
                <p className="text-[9px] sm:text-[10px] uppercase tracking-wider text-muted-foreground">
                  Ideal (contract)
                </p>
                <p className="text-xs sm:text-base font-bold font-mono tabular-nums truncate">
                  {formatUGX(idealTotal)}
                </p>
                <p className="text-[9px] sm:text-[10px] text-muted-foreground">Scheduled by contract</p>
              </div>
              <div className="rounded-xl bg-muted/50 px-2.5 py-2">
                <p className="text-[9px] sm:text-[10px] uppercase tracking-wider text-muted-foreground">
                  Difference
                </p>
                <p className="text-xs sm:text-base font-bold font-mono tabular-nums truncate">
                  {formatUGX(horizonTotal - idealTotal)}
                </p>
                <p className="text-[9px] sm:text-[10px] text-muted-foreground">Behavior minus ideal</p>
              </div>
              <div className="rounded-xl bg-muted/50 px-2.5 py-2">
                <p className="text-[9px] sm:text-[10px] uppercase tracking-wider text-muted-foreground">
                  Average per {granularity}
                </p>
                <p className="text-xs sm:text-base font-bold font-mono tabular-nums truncate">
                  {formatUGX(data.periods.length ? Math.round(horizonTotal / data.periods.length) : 0)}
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
                    formatter={(value: unknown, name) =>
                      [formatUGX(Number(value ?? 0)), name === 'actual' ? 'Actual' : name === 'ideal' ? 'Ideal (contract)' : 'Behavior projection']
                    }
                    contentStyle={{ fontSize: 11 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar dataKey="actual" name="Actual paid" fill="hsl(var(--muted-foreground))" />
                  <Bar dataKey="forecast" name="Behavior projection" fill="hsl(var(--primary))" />
                  <Line
                    type="monotone"
                    dataKey="ideal"
                    name="Ideal (contract)"
                    stroke="hsl(var(--muted-foreground))"
                    strokeDasharray="4 3"
                    strokeWidth={1.5}
                    dot={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div className="max-h-80 overflow-y-auto overflow-x-auto rounded-xl border border-border/60">
              <table className="w-full min-w-[320px] text-[10px] sm:text-xs">
                <thead className="bg-muted/50 sticky top-0 z-10">
                  <tr>
                    <th className="text-left px-2.5 py-1.5 font-medium">Period</th>
                    <th className="text-right px-2.5 py-1.5 font-medium">Behavior projection</th>
                    <th className="text-right px-2.5 py-1.5 font-medium hidden sm:table-cell">
                      Ideal (contract)
                    </th>
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
                            {formatUGX(historyProjection.get(p.index) ?? 0)}
                          </td>
                          <td className="px-2.5 py-1.5 text-right font-mono tabular-nums hidden sm:table-cell text-muted-foreground whitespace-nowrap">
                            {formatUGX(p.scheduled_amount)}
                          </td>
                        </tr>
                        {open && (
                          <tr className="bg-muted/20">
                            <td colSpan={3} className="px-2.5 py-2">
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
