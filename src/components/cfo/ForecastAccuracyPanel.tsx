import { useMemo, useState } from 'react';
import { format, parseISO } from 'date-fns';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Download,
  Loader2,
  Target,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import {
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useReceivablesForecastAccuracy,
  useReceivablesForecastTrackRecord,
  useRecordForecastSnapshot,
} from '@/hooks/useReceivables';

const ORIGIN_OPTIONS = [
  { value: 8, label: '8 replay points' },
  { value: 12, label: '12 replay points' },
  { value: 16, label: '16 replay points' },
  { value: 24, label: '24 replay points' },
];

const shortDate = (iso: string) => {
  try {
    return format(parseISO(iso), 'd MMM');
  } catch {
    return iso;
  }
};

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${v.toFixed(1)}%`;

function accuracyTone(v: number | null) {
  if (v === null) return 'text-muted-foreground';
  if (v >= 80) return 'text-emerald-600';
  if (v >= 60) return 'text-amber-600';
  return 'text-destructive';
}

function downloadCsv(name: string, rows: (string | number | null)[][]) {
  const csv = rows
    .map((r) =>
      r
        .map((c) => {
          const s = c === null || c === undefined ? '' : String(c);
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

export default function ForecastAccuracyPanel() {
  const [origins, setOrigins] = useState(12);
  const [horizon, setHorizon] = useState(7);

  const accuracy = useReceivablesForecastAccuracy(origins, 7, [1, 7, 30]);
  const track = useReceivablesForecastTrackRecord(null, 60);
  const snapshot = useRecordForecastSnapshot();

  const horizons = accuracy.data?.horizons ?? [];
  const selected = horizons.find((h) => h.horizon_days === horizon) ?? horizons[0];

  const chartData = useMemo(
    () =>
      (accuracy.data?.series ?? [])
        .filter((r) => r.horizon_days === (selected?.horizon_days ?? horizon))
        .sort((a, b) => a.origin.localeCompare(b.origin))
        .map((r) => ({
          label: shortDate(r.window_from),
          Predicted: Math.round(r.forecast),
          Actual: Math.round(r.actual),
          Low: Math.round(r.low),
          High: Math.round(r.high),
        })),
    [accuracy.data, selected, horizon]
  );

  const products = useMemo(
    () =>
      (accuracy.data?.products ?? [])
        .filter((p) => p.horizon_days === (selected?.horizon_days ?? horizon))
        .sort((a, b) => b.total_actual - a.total_actual),
    [accuracy.data, selected, horizon]
  );

  const exportBacktest = () => {
    const rows: (string | number | null)[][] = [
      [
        'Origin (model as-at)',
        'Horizon days',
        'Window from',
        'Window to',
        'Predicted (UGX)',
        'Actual (UGX)',
        'Error %',
        'Range low',
        'Range high',
        'Actual inside range',
      ],
      ...(accuracy.data?.series ?? []).map((r) => [
        r.origin,
        r.horizon_days,
        r.window_from,
        r.window_to,
        Math.round(r.forecast),
        Math.round(r.actual),
        r.error_pct,
        Math.round(r.low),
        Math.round(r.high),
        r.in_band ? 'Yes' : 'No',
      ]),
    ];
    downloadCsv(`forecast-backtest-${accuracy.data?.as_at ?? 'export'}.csv`, rows);
  };

  const exportTrack = () => {
    const rows: (string | number | null)[][] = [
      [
        'Issued on',
        'Granularity',
        'Period start',
        'Period end',
        'Horizon days',
        'Quality',
        'Predicted (UGX)',
        'Actual (UGX)',
        'Error %',
        'Actual inside range',
      ],
      ...(track.data?.rows ?? []).map((r) => [
        r.issued_on,
        r.granularity,
        r.period_start,
        r.period_end,
        r.horizon_days,
        r.quality,
        Math.round(r.modelled_forecast),
        r.actual === null ? null : Math.round(r.actual),
        r.error_pct,
        r.in_band === null ? 'Pending' : r.in_band ? 'Yes' : 'No',
      ]),
    ];
    downloadCsv(`forecast-track-record-${track.data?.as_at ?? 'export'}.csv`, rows);
  };

  return (
    <Card className="border-primary/20">
      <CardContent className="space-y-5 p-4 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Target className="h-5 w-5 text-primary" />
              <h3 className="text-base font-semibold sm:text-lg">Forecast accuracy (back-tested)</h3>
            </div>
            <p className="text-xs text-muted-foreground sm:text-sm">
              The same forecasting model is re-run as it would have stood on past dates, then graded
              against the cash actually collected afterwards.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={String(origins)} onValueChange={(v) => setOrigins(Number(v))}>
              <SelectTrigger className="h-9 w-[170px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ORIGIN_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={String(o.value)}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={exportBacktest} disabled={!accuracy.data}>
              <Download className="mr-1.5 h-3.5 w-3.5" /> Export
            </Button>
          </div>
        </div>

        {accuracy.isLoading ? (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Replaying the model over history…
          </div>
        ) : accuracy.error ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Could not run the back-test: {(accuracy.error as Error).message}</span>
          </div>
        ) : (
          <Tabs defaultValue="backtest" className="space-y-4">
            <TabsList className="w-full justify-start overflow-x-auto">
              <TabsTrigger value="backtest" className="text-xs sm:text-sm">
                Back-test
              </TabsTrigger>
              <TabsTrigger value="lines" className="text-xs sm:text-sm">
                By business line
              </TabsTrigger>
              <TabsTrigger value="issued" className="text-xs sm:text-sm">
                Issued forecasts
              </TabsTrigger>
            </TabsList>

            {/* ---------------- Back-test ---------------- */}
            <TabsContent value="backtest" className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
                {horizons.map((h) => (
                  <button
                    key={h.horizon_days}
                    type="button"
                    onClick={() => setHorizon(h.horizon_days)}
                    className={`rounded-lg border p-3 text-left transition ${
                      (selected?.horizon_days ?? horizon) === h.horizon_days
                        ? 'border-primary bg-primary/5'
                        : 'hover:bg-muted/40'
                    }`}
                  >
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      {h.horizon_days === 1 ? 'Next day' : `Next ${h.horizon_days} days`}
                    </p>
                    <p className={`text-lg font-semibold ${accuracyTone(h.accuracy_pct)}`}>
                      {pct(h.accuracy_pct)}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      accurate · {h.runs} test{h.runs === 1 ? '' : 's'}
                    </p>
                  </button>
                ))}
                <div className="rounded-lg border bg-muted/30 p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Bias</p>
                  <p className="flex items-center gap-1 text-lg font-semibold">
                    {(selected?.bias_pct ?? 0) < 0 ? (
                      <TrendingDown className="h-4 w-4 text-amber-600" />
                    ) : (
                      <TrendingUp className="h-4 w-4 text-emerald-600" />
                    )}
                    {pct(selected?.bias_pct)}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {(selected?.bias_pct ?? 0) < 0 ? 'under-forecasts' : 'over-forecasts'} on average
                  </p>
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <div className="rounded-lg border p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Total predicted
                  </p>
                  <p className="text-sm font-semibold">{formatUGX(selected?.total_forecast ?? 0)}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Total actually collected
                  </p>
                  <p className="text-sm font-semibold">{formatUGX(selected?.total_actual ?? 0)}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Landed inside published range
                  </p>
                  <p className="text-sm font-semibold">{pct(selected?.band_hit_pct)}</p>
                </div>
              </div>

              <div className="h-[260px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                    <YAxis
                      tick={{ fontSize: 11 }}
                      tickFormatter={(v: number) => `${Math.round(v / 1_000_000)}M`}
                    />
                    <Tooltip
                      formatter={(v: number, n: string) => [formatUGX(v), n]}
                      labelFormatter={(l: string) => `Window starting ${l}`}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="Predicted" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="Actual" stroke="hsl(var(--chart-2, 142 71% 45%))" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="Low" stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" strokeWidth={1} dot={false} />
                    <Line type="monotone" dataKey="High" stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" strokeWidth={1} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[640px] text-xs sm:text-sm">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="p-2 font-medium">Window</th>
                      <th className="p-2 text-right font-medium">Predicted</th>
                      <th className="p-2 text-right font-medium">Actual</th>
                      <th className="p-2 text-right font-medium">Error</th>
                      <th className="p-2 text-right font-medium">In range</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(accuracy.data?.series ?? [])
                      .filter((r) => r.horizon_days === (selected?.horizon_days ?? horizon))
                      .sort((a, b) => b.origin.localeCompare(a.origin))
                      .map((r) => (
                        <tr key={`${r.origin}-${r.horizon_days}`} className="border-t">
                          <td className="p-2">
                            {shortDate(r.window_from)}
                            {r.window_from !== r.window_to ? ` – ${shortDate(r.window_to)}` : ''}
                          </td>
                          <td className="p-2 text-right">{formatUGX(r.forecast)}</td>
                          <td className="p-2 text-right">{formatUGX(r.actual)}</td>
                          <td
                            className={`p-2 text-right font-medium ${
                              Math.abs(r.error_pct ?? 0) <= 20 ? 'text-emerald-600' : 'text-amber-600'
                            }`}
                          >
                            {pct(r.error_pct)}
                          </td>
                          <td className="p-2 text-right">
                            {r.in_band ? (
                              <CheckCircle2 className="ml-auto h-4 w-4 text-emerald-600" />
                            ) : (
                              <span className="text-muted-foreground">No</span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </TabsContent>

            {/* ---------------- By business line ---------------- */}
            <TabsContent value="lines">
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[720px] text-xs sm:text-sm">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="p-2 font-medium">Business line</th>
                      <th className="p-2 text-right font-medium">Accuracy</th>
                      <th className="p-2 text-right font-medium">Bias</th>
                      <th className="p-2 text-right font-medium">Predicted</th>
                      <th className="p-2 text-right font-medium">Actual</th>
                      <th className="p-2 text-right font-medium">Tests</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p) => (
                      <tr key={`${p.product_key}-${p.horizon_days}`} className="border-t">
                        <td className="p-2">
                          <p className="font-medium">{p.product_label}</p>
                          <p className="text-[11px] text-muted-foreground">{p.category_label}</p>
                        </td>
                        <td className={`p-2 text-right font-semibold ${accuracyTone(p.accuracy_pct)}`}>
                          {pct(p.accuracy_pct)}
                        </td>
                        <td className="p-2 text-right">{pct(p.bias_pct)}</td>
                        <td className="p-2 text-right">{formatUGX(p.total_forecast)}</td>
                        <td className="p-2 text-right">{formatUGX(p.total_actual)}</td>
                        <td className="p-2 text-right text-muted-foreground">{p.runs}</td>
                      </tr>
                    ))}
                    {products.length === 0 && (
                      <tr>
                        <td colSpan={6} className="p-4 text-center text-muted-foreground">
                          No graded business lines for this horizon yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </TabsContent>

            {/* ---------------- Issued forecasts ---------------- */}
            <TabsContent value="issued" className="space-y-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground sm:text-sm">
                  Forecasts saved on the day they were published, graded automatically once the
                  period closes — no recalculation after the fact.
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={snapshot.isPending}
                    onClick={() =>
                      snapshot.mutate(
                        { granularity: 'month', periods: 6 },
                        {
                          onSuccess: (d) =>
                            toast.success(
                              `Today's forecast recorded (${d.periods_recorded} periods)`
                            ),
                          onError: (e) => toast.error((e as Error).message),
                        }
                      )
                    }
                  >
                    {snapshot.isPending ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Camera className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Record today
                  </Button>
                  <Button variant="outline" size="sm" onClick={exportTrack} disabled={!track.data}>
                    <Download className="mr-1.5 h-3.5 w-3.5" /> Export
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="rounded-lg border p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Graded</p>
                  <p className="text-sm font-semibold">{track.data?.summary.graded ?? 0}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Awaiting close
                  </p>
                  <p className="text-sm font-semibold">{track.data?.summary.pending ?? 0}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Accuracy
                  </p>
                  <p className={`text-sm font-semibold ${accuracyTone(track.data?.summary.accuracy_pct ?? null)}`}>
                    {pct(track.data?.summary.accuracy_pct)}
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Bias</p>
                  <p className="text-sm font-semibold">{pct(track.data?.summary.bias_pct)}</p>
                </div>
              </div>

              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[720px] text-xs sm:text-sm">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="p-2 font-medium">Issued</th>
                      <th className="p-2 font-medium">Period</th>
                      <th className="p-2 text-right font-medium">Predicted</th>
                      <th className="p-2 text-right font-medium">Actual</th>
                      <th className="p-2 text-right font-medium">Error</th>
                      <th className="p-2 text-right font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(track.data?.rows ?? []).map((r) => (
                      <tr key={`${r.granularity}-${r.issued_on}-${r.period_start}`} className="border-t">
                        <td className="p-2 whitespace-nowrap">{shortDate(r.issued_on)}</td>
                        <td className="p-2 whitespace-nowrap">
                          {shortDate(r.period_start)} – {shortDate(r.period_end)}
                          <span className="ml-1 text-[11px] text-muted-foreground">
                            ({r.granularity})
                          </span>
                        </td>
                        <td className="p-2 text-right">{formatUGX(r.modelled_forecast)}</td>
                        <td className="p-2 text-right">
                          {r.actual === null ? '—' : formatUGX(r.actual)}
                        </td>
                        <td className="p-2 text-right">{pct(r.error_pct)}</td>
                        <td className="p-2 text-right">
                          {r.actual === null ? (
                            <Badge variant="outline" className="text-[10px]">
                              Pending
                            </Badge>
                          ) : r.in_band ? (
                            <Badge className="bg-emerald-600 text-[10px] hover:bg-emerald-600">
                              In range
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="text-[10px]">
                              Outside range
                            </Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                    {(track.data?.rows ?? []).length === 0 && (
                      <tr>
                        <td colSpan={6} className="p-4 text-center text-muted-foreground">
                          No issued forecasts recorded yet — the nightly job starts the log tonight.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </TabsContent>
          </Tabs>
        )}

        {accuracy.data && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {accuracy.data.meta.method_note} Replay points: {accuracy.data.meta.origins_used} spaced{' '}
            {accuracy.data.meta.step_days} days apart · history from{' '}
            {accuracy.data.meta.first_history_date ?? '—'} · model{' '}
            {accuracy.data.meta.model_version}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
