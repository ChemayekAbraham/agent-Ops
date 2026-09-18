import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import {
  generatePartnerReturnsForecastPdf,
  type ForecastPdfDetailGroup,
} from '@/lib/partnerReturnsForecastPdf';
import {
  ComposedChart, Bar, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import {
  PartnerReturnsDrilldownDialog,
  METRIC_LABELS,
  type DrilldownMetric,
  type DrilldownTarget,
} from './PartnerReturnsDrilldownDialog';

/** Metrics exported as supporting records, in report order. */
const EXPORT_METRICS: { metric: DrilldownMetric; field: keyof Row }[] = [
  { metric: 'forecast', field: 'forecast_returns' },
  { metric: 'actual', field: 'actual_returns_paid' },
  { metric: 'receivable', field: 'partner_receivable' },
  { metric: 'topups', field: 'topups' },
  { metric: 'promissory', field: 'promissory_receivable' },
  { metric: 'compounding', field: 'compounding' },
];

/** Keeps a single export from firing hundreds of detail queries on a day bucket. */
const MAX_DETAIL_QUERIES = 60;
const DETAIL_ROW_LIMIT = 100;

interface Row {
  key: string;
  label: string;
  is_past: boolean;
  forecast_returns: number;
  forecast_count: number;
  actual_returns_paid: number;
  actual_count: number;
  variance: number;
  partner_receivable: number;
  topups: number;
  /** Predicted top-ups for future periods, from recent top-up behaviour. */
  topups_forecast: number;
  promissory_receivable: number;
  compounding: number;
  net: number;
}

interface Payload {
  bucket: string;
  today: string;
  rows: Row[];
  topup_model?: {
    basis_buckets: number;
    baseline_per_bucket: number;
    trend_per_bucket: number;
  };
  portfolio_count: number;
  committed_capital: number;
  promissory_outstanding: number;
  partner_receivable_outstanding: number;
}

const COLORS = {
  forecast: 'hsl(var(--primary))',
  actual: 'hsl(0 72% 51%)',
  receivable: 'hsl(152 60% 40%)',
  topups: 'hsl(199 89% 48%)',
  promissory: 'hsl(38 92% 50%)',
  compounding: 'hsl(271 76% 53%)',
  net: 'hsl(var(--foreground))',
};

export function PartnerReturnsForecastPanel({
  start,
  end,
  bucket,
}: {
  start: Date;
  end: Date;
  bucket: 'day' | 'week' | 'month';
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['partner-returns-forecast', start.toISOString(), end.toISOString(), bucket],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_partner_ops_returns_forecast', {
        p_start: start.toISOString(),
        p_end: end.toISOString(),
        p_bucket: bucket,
      });
      if (error) throw error;
      return data as Payload;
    },
    staleTime: 60_000,
  });

  const rows = data?.rows ?? [];
  const [drilldown, setDrilldown] = useState<DrilldownTarget | null>(null);

  const openDrilldown = (row: Row, metric: DrilldownMetric) =>
    setDrilldown({ period: row.key, periodLabel: row.label, metric, bucket });

  const totals = useMemo(() => {
    const past = rows.filter((r) => r.is_past);
    return {
      forecastPast: past.reduce((s, r) => s + Number(r.forecast_returns), 0),
      actualPast: past.reduce((s, r) => s + Number(r.actual_returns_paid), 0),
      forecastAhead: rows.filter((r) => !r.is_past).reduce((s, r) => s + Number(r.forecast_returns), 0),
      topups: rows.reduce((s, r) => s + Number(r.topups), 0),
      topupsPredicted: rows.reduce((s, r) => s + Number(r.topups_forecast ?? 0), 0),
      promissory: rows.reduce((s, r) => s + Number(r.promissory_receivable), 0),
      compounding: rows.reduce((s, r) => s + Number(r.compounding), 0),
      receivable: rows.reduce((s, r) => s + Number(r.partner_receivable), 0),
      net: rows.reduce((s, r) => s + Number(r.net), 0),
    };
  }, [rows]);

  const deliveryRate = totals.forecastPast > 0 ? (totals.actualPast / totals.forecastPast) * 100 : 0;

  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    if (!rows.length) return;
    setExporting(true);
    try {
      // Only pull records for figures that actually carry a value, newest periods
      // first, so a wide day-bucket window can't spawn hundreds of queries.
      const jobs: { row: Row; metric: DrilldownMetric }[] = [];
      for (const row of [...rows].reverse()) {
        for (const { metric, field } of EXPORT_METRICS) {
          if (Number(row[field]) > 0) jobs.push({ row, metric });
        }
      }
      const capped = jobs.slice(0, MAX_DETAIL_QUERIES);

      const groups: ForecastPdfDetailGroup[] = [];
      for (const job of capped) {
        const { data: detail, error } = await (supabase as any).rpc(
          'get_partner_ops_returns_forecast_detail',
          {
            p_period: job.row.key,
            p_metric: job.metric,
            p_bucket: bucket,
            p_limit: DETAIL_ROW_LIMIT,
          },
        );
        if (error) throw error;
        const detailRows = (detail?.rows ?? []) as any[];
        if (!detailRows.length) continue;
        groups.push({
          periodLabel: job.row.label,
          metricLabel: METRIC_LABELS[job.metric],
          total: Number(detail?.total ?? 0),
          count: Number(detail?.count ?? detailRows.length),
          truncated: Boolean(detail?.truncated),
          rows: detailRows.map((r) => ({
            name: r.name ?? '—',
            detail: r.detail ?? '—',
            amount: Number(r.amount ?? 0),
            occurred_on: r.occurred_on ?? '—',
            status: r.status ?? '—',
          })),
        });
      }
      // Report reads oldest period first, matching the on-screen table.
      groups.reverse();

      const blob = await generatePartnerReturnsForecastPdf(
        rows.map((r) => ({
          key: r.key,
          label: r.label,
          is_past: r.is_past,
          forecast_returns: Number(r.forecast_returns),
          actual_returns_paid: Number(r.actual_returns_paid),
          variance: Number(r.variance),
          partner_receivable: Number(r.partner_receivable),
          topups: Number(r.topups),
          promissory_receivable: Number(r.promissory_receivable),
          topups_forecast: Number(r.topups_forecast ?? 0),
          compounding: Number(r.compounding),
          net: Number(r.net),
        })),
        groups,
        {
          rangeText: `${format(start, 'dd MMM yyyy')} – ${format(end, 'dd MMM yyyy')}`,
          bucketText: bucket === 'day' ? 'Daily' : bucket === 'week' ? 'Weekly' : 'Monthly',
          portfolioCount: Number(data?.portfolio_count ?? 0),
          committedCapital: Number(data?.committed_capital ?? 0),
          promissoryOutstanding: Number(data?.promissory_outstanding ?? 0),
        },
      );

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `partner-returns-forecast-${format(start, 'yyyyMMdd')}-${format(end, 'yyyyMMdd')}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      toast.success(
        jobs.length > capped.length
          ? `Report downloaded — supporting records limited to the ${capped.length} largest figure groups.`
          : 'Report downloaded.',
      );
    } catch (e: any) {
      toast.error(e?.message || 'Could not build the report.');
    } finally {
      setExporting(false);
    }
  };

  const chartData = rows.map((r) => ({
    label: r.label,
    'Returns payable forecast': Number(r.forecast_returns),
    'Actually paid': Number(r.actual_returns_paid),
    'Partner receivable': Number(r.partner_receivable),
    'Top-ups': Number(r.topups),
    'Predicted top-ups': Number(r.topups_forecast ?? 0),
    'Promissory receivable': Number(r.promissory_receivable),
    Compounding: Number(r.compounding),
    Net: Number(r.net),
  }));

  const ChartTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    return (
      <div className="rounded-lg border border-border bg-background p-2.5 text-xs shadow-lg space-y-0.5">
        <p className="font-bold">{label}</p>
        {payload.map((p: any) => (
          <p key={p.name} className="flex items-center justify-between gap-3 font-mono tabular-nums">
            <span style={{ color: p.color }}>{p.name}</span>
            <span>{formatUGX(Number(p.value))}</span>
          </p>
        ))}
      </div>
    );
  };

  if (isLoading) return <Skeleton className="h-96 w-full rounded-xl" />;

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-bold">Partner Ops Returns — forecast vs actually paid</h2>
            <p className="text-[11px] text-muted-foreground">
              Forecast is every live portfolio&apos;s monthly Returns cycle from the Partner Ops
              portfolios themselves. Actually paid reads posted Returns payments from the ledger.
              Receivables, top-ups, promissory notes and compounding are shown against it so the net
              position is readable at a glance.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">
              {Number(data?.portfolio_count ?? 0)} portfolios · {formatUGX(Number(data?.committed_capital ?? 0))} committed
            </Badge>
            <Button size="sm" variant="outline" onClick={handleExport} disabled={exporting || !rows.length}>
              {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              <span className="ml-1.5 text-xs">{exporting ? 'Building report…' : 'Export PDF'}</span>
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <Stat label="Forecast (past periods)" value={totals.forecastPast} />
          <Stat label="Actually paid (past)" value={totals.actualPast} tone="rose" />
          <Stat
            label="Delivered vs forecast"
            raw={`${Math.round(deliveryRate)}%`}
            sub={formatUGX(totals.actualPast - totals.forecastPast)}
          />
          <Stat label="Forecast ahead" value={totals.forecastAhead} />
          <Stat label="Receivable from partners" value={totals.receivable} tone="emerald" />
          <Stat label="Top-ups received" value={totals.topups} tone="emerald" />
          <Stat
            label="Predicted top-ups ahead"
            value={totals.topupsPredicted}
            tone="emerald"
            sub={
              data?.topup_model?.basis_buckets
                ? `from ${data.topup_model.basis_buckets} recent period${data.topup_model.basis_buckets === 1 ? '' : 's'}`
                : 'not enough history yet'
            }
          />
          <Stat label="Promissory notes receivable" value={totals.promissory} tone="amber" />
          <Stat label="Compounding (reinvested)" value={totals.compounding} tone="violet" />
        </div>

        {data?.topup_model?.basis_buckets ? (
          <p className="text-[11px] text-muted-foreground">
            Predicted top-ups use the last {data.topup_model.basis_buckets} completed period
            {data.topup_model.basis_buckets === 1 ? '' : 's'} of real top-ups — averaging{' '}
            {formatUGX(Number(data.topup_model.baseline_per_bucket))} per period and{' '}
            {Number(data.topup_model.trend_per_bucket) >= 0 ? 'rising' : 'falling'} by{' '}
            {formatUGX(Math.abs(Number(data.topup_model.trend_per_bucket)))} each period. Future
            periods carry that prediction into the net position; past periods always show what was
            really received.
          </p>
        ) : null}


        <div className="rounded-xl border border-border p-3">
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1">
            Net position across the window
          </p>
          <p className={`text-lg font-bold font-mono tabular-nums ${totals.net >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
            {formatUGX(totals.net)}
          </p>
          <p className="text-[11px] text-muted-foreground">
            Receivables + top-ups + promissory + compounding, less Returns paid in past periods and
            Returns forecast in future periods.
          </p>
        </div>

        <div className="h-96">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10 }} width={70} tickFormatter={(v) => new Intl.NumberFormat('en-UG').format(Number(v))} />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine y={0} stroke="hsl(var(--border))" />
              <Bar dataKey="Top-ups" fill={COLORS.topups} radius={[3, 3, 0, 0]} />
              <Bar dataKey="Partner receivable" fill={COLORS.receivable} radius={[3, 3, 0, 0]} />
              <Bar dataKey="Promissory receivable" fill={COLORS.promissory} radius={[3, 3, 0, 0]} />
              <Bar dataKey="Compounding" fill={COLORS.compounding} radius={[3, 3, 0, 0]} />
              <Line
                type="monotone"
                dataKey="Predicted top-ups"
                stroke={COLORS.topups}
                strokeWidth={2}
                strokeDasharray="3 3"
                dot={{ r: 2 }}
              />
              <Line type="monotone" dataKey="Forecast" stroke={COLORS.forecast} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="Actually paid" stroke={COLORS.actual} strokeWidth={2} dot={{ r: 2 }} />
              <Line type="monotone" dataKey="Net" stroke={COLORS.net} strokeWidth={2} strokeDasharray="5 4" dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        <p className="text-[11px] text-muted-foreground">
          Tap any figure in the table to see the records behind it.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="py-2 pr-3 font-semibold">Period</th>
                <th className="py-2 pr-3 font-semibold text-right">Forecast</th>
                <th className="py-2 pr-3 font-semibold text-right">Actually paid</th>
                <th className="py-2 pr-3 font-semibold text-right">Difference</th>
                <th className="py-2 pr-3 font-semibold text-right">Receivable</th>
                <th className="py-2 pr-3 font-semibold text-right">Top-ups</th>
                <th className="py-2 pr-3 font-semibold text-right">Predicted top-ups</th>
                <th className="py-2 pr-3 font-semibold text-right">Promissory</th>
                <th className="py-2 pr-3 font-semibold text-right">Compounding</th>
                <th className="py-2 font-semibold text-right">Net</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-border/60">
                  <td className="py-2 pr-3 font-medium">
                    {r.label}
                    {!r.is_past && <span className="ml-1 text-[10px] text-muted-foreground">(ahead)</span>}
                  </td>
                  <DrillCell value={Number(r.forecast_returns)} onClick={() => openDrilldown(r, 'forecast')} />
                  <DrillCell
                    value={r.is_past ? Number(r.actual_returns_paid) : null}
                    onClick={() => openDrilldown(r, 'actual')}
                  />
                  <td
                    className={`py-2 pr-3 text-right font-mono tabular-nums ${
                      Number(r.variance) >= 0 ? 'text-emerald-600' : 'text-rose-600'
                    }`}
                  >
                    {r.is_past ? formatUGX(Number(r.variance)) : '—'}
                  </td>
                  <DrillCell value={Number(r.partner_receivable)} onClick={() => openDrilldown(r, 'receivable')} />
                  <DrillCell value={Number(r.topups)} onClick={() => openDrilldown(r, 'topups')} />
                  <td className="py-2 pr-3 text-right font-mono tabular-nums text-muted-foreground">
                    {r.is_past ? '—' : formatUGX(Number(r.topups_forecast ?? 0))}
                  </td>
                  <DrillCell value={Number(r.promissory_receivable)} onClick={() => openDrilldown(r, 'promissory')} />
                  <DrillCell value={Number(r.compounding)} onClick={() => openDrilldown(r, 'compounding')} />
                  <td
                    className={`py-2 text-right font-mono tabular-nums font-semibold ${
                      Number(r.net) >= 0 ? 'text-emerald-600' : 'text-rose-600'
                    }`}
                  >
                    {formatUGX(Number(r.net))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <PartnerReturnsDrilldownDialog target={drilldown} onClose={() => setDrilldown(null)} />
      </CardContent>
    </Card>
  );
}

function DrillCell({ value, onClick }: { value: number | null; onClick: () => void }) {
  if (value === null) {
    return <td className="py-2 pr-3 text-right font-mono tabular-nums text-muted-foreground">—</td>;
  }
  return (
    <td className="py-2 pr-3 text-right font-mono tabular-nums">
      <button
        type="button"
        onClick={onClick}
        className="underline decoration-dotted decoration-muted-foreground/60 underline-offset-2 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
      >
        {formatUGX(value)}
      </button>
    </td>
  );
}

function Stat({
  label,
  value,
  raw,
  sub,
  tone,
}: {
  label: string;
  value?: number;
  raw?: string;
  sub?: string;
  tone?: 'emerald' | 'rose' | 'amber' | 'violet';
}) {
  const toneClass =
    tone === 'emerald'
      ? 'text-emerald-600'
      : tone === 'rose'
        ? 'text-rose-600'
        : tone === 'amber'
          ? 'text-amber-600'
          : tone === 'violet'
            ? 'text-violet-600'
            : '';
  return (
    <div className="rounded-xl border border-border p-3">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className={`text-sm font-bold font-mono tabular-nums ${toneClass}`}>
        {raw ?? formatUGX(Number(value ?? 0))}
      </p>
      {sub ? <p className="text-[10px] text-muted-foreground font-mono">{sub}</p> : null}
    </div>
  );
}
