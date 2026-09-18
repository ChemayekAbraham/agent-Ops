import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { LineChart as LineChartIcon, CalendarRange, RefreshCw, TrendingUp } from 'lucide-react';
import { PartnerReturnsForecastPanel } from './PartnerReturnsForecastPanel';

type Bucket = 'day' | 'week' | 'month';
type RangePreset = '7d' | '30d' | '90d' | '12m' | 'custom';

interface SeriesPoint { key: string; amount: number; count: number }
interface SeriesCategory {
  key: string;
  label: string;
  kind: 'forecast' | 'actual';
  flow?: 'in' | 'out';
  total: number;
  count: number;
  points: SeriesPoint[];
}
interface SeriesResponse {
  bucket: Bucket;
  buckets: { key: string; label: string }[];
  categories: SeriesCategory[];
  partners?: PartnerProjection[];
  portfolio_count?: number;
  committed_capital?: number;
}

interface PartnerProjection {
  partner_id: string;
  partner_name: string;
  phone: string | null;
  portfolios: number;
  committed: number;
  payouts: number;
  next_due: string | null;
  projected: number;
}

const PRESETS: { key: RangePreset; label: string; bucket: Bucket }[] = [
  { key: '7d', label: 'Next 7 days', bucket: 'day' },
  { key: '30d', label: 'Next 30 days', bucket: 'day' },
  { key: '90d', label: 'Next 90 days', bucket: 'week' },
  { key: '12m', label: 'Next 12 months', bucket: 'month' },
];

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}

function resolveRange(preset: RangePreset, customStart: string, customEnd: string) {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);

  if (preset === 'custom') {
    const s = customStart ? new Date(`${customStart}T00:00:00`) : start;
    const e = customEnd ? new Date(`${customEnd}T23:59:59`) : new Date(start.getTime() + 30 * 864e5);
    return { start: s, end: e };
  }
  if (preset === '7d') end.setDate(end.getDate() + 7);
  else if (preset === '30d') end.setDate(end.getDate() + 30);
  else if (preset === '90d') end.setDate(end.getDate() + 90);
  else end.setMonth(end.getMonth() + 12);

  // include a little history so trends are visible next to the forecast
  const back = new Date(start);
  back.setDate(back.getDate() - (preset === '12m' ? 90 : preset === '90d' ? 30 : 14));
  return { start: back, end };
}

export function CashflowForecastGraphs() {
  const [preset, setPreset] = useState<RangePreset>('90d');
  const [bucket, setBucket] = useState<Bucket>('week');
  const [customStart, setCustomStart] = useState(isoDay(new Date()));
  const [customEnd, setCustomEnd] = useState(isoDay(new Date(Date.now() + 90 * 864e5)));
  const [activeCat, setActiveCat] = useState<string>('roi_forecast');
  const [flowFilter, setFlowFilter] = useState<'all' | 'in' | 'out'>('all');

  const { start, end } = useMemo(
    () => resolveRange(preset, customStart, customEnd),
    [preset, customStart, customEnd],
  );

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['cashflow-forecast-series', start.toISOString(), end.toISOString(), bucket],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_cashflow_forecast_series', {
        p_start: start.toISOString(),
        p_end: end.toISOString(),
        p_bucket: bucket,
      });
      if (error) throw error;
      return data as SeriesResponse;
    },
    staleTime: 60_000,
  });

  const allCategories = data?.categories ?? [];
  const categories = useMemo(
    () => (flowFilter === 'all' ? allCategories : allCategories.filter((c) => (c.flow ?? 'out') === flowFilter)),
    [allCategories, flowFilter],
  );
  const active = categories.find((c) => c.key === activeCat) ?? categories[0] ?? null;
  const isInflow = (active?.flow ?? 'out') === 'in';
  const inflowTotal = allCategories
    .filter((c) => c.flow === 'in')
    .reduce((s, c) => s + Number(c.total), 0);
  const outflowTotal = allCategories
    .filter((c) => (c.flow ?? 'out') === 'out')
    .reduce((s, c) => s + Number(c.total), 0);
  const partners = data?.partners ?? [];

  const chartData = useMemo(() => {
    if (!data || !active) return [];
    const map = new Map(active.points.map((p) => [p.key, p]));
    return data.buckets.map((b) => ({
      label: b.label,
      amount: Number(map.get(b.key)?.amount ?? 0),
      count: Number(map.get(b.key)?.count ?? 0),
    }));
  }, [data, active]);

  const peak = chartData.reduce((m, d) => (d.amount > m ? d.amount : m), 0);
  const total = chartData.reduce((s, d) => s + d.amount, 0);
  const avg = chartData.length ? total / chartData.length : 0;

  const CustomTooltip = ({ active: on, payload, label }: any) => {
    if (!on || !payload?.length) return null;
    return (
      <div className="rounded-lg border border-border bg-background p-2.5 text-xs shadow-lg">
        <p className="font-bold">{label}</p>
        <p className="font-mono tabular-nums">{formatUGX(Number(payload[0].value))}</p>
        <p className="text-muted-foreground">{payload[0].payload.count} entries</p>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <LineChartIcon className="h-5 w-5 text-primary" />
            Graphic Cashflow Forecast
          </h1>
          <p className="text-sm text-muted-foreground">
            Amount versus time for every payout category. Forecasted Returns are captured straight from
            the portfolios on the Partner Ops dashboard and projected forward per partner, so they shift
            automatically with Partner Ops inputs and outputs.
          </p>
          {data ? (
            <p className="text-[11px] text-muted-foreground mt-1">
              Source: {Number(data.portfolio_count ?? 0)} Partner Ops portfolios ·{' '}
              {formatUGX(Number(data.committed_capital ?? 0))} committed capital
            </p>
          ) : null}
          {data ? (
            <p className="text-[11px] mt-1">
              <span className="text-emerald-600 font-semibold">Cash coming in: {formatUGX(inflowTotal)}</span>
              <span className="text-muted-foreground"> · </span>
              <span className="text-rose-600 font-semibold">Cash going out: {formatUGX(outflowTotal)}</span>
            </p>
          ) : null}
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn('h-4 w-4 mr-1.5', isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Time controls */}
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              Window
            </span>
            {PRESETS.map((p) => (
              <Button
                key={p.key}
                size="sm"
                variant={preset === p.key ? 'default' : 'outline'}
                onClick={() => {
                  setPreset(p.key);
                  setBucket(p.bucket);
                }}
              >
                {p.label}
              </Button>
            ))}
            <Button
              size="sm"
              variant={preset === 'custom' ? 'default' : 'outline'}
              onClick={() => setPreset('custom')}
            >
              <CalendarRange className="h-4 w-4 mr-1.5" />
              Custom
            </Button>
          </div>

          {preset === 'custom' && (
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <p className="text-[11px] text-muted-foreground mb-1">From</p>
                <Input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} className="h-9 w-[150px]" />
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground mb-1">To</p>
                <Input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} className="h-9 w-[150px]" />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              Time axis
            </span>
            {(['day', 'week', 'month'] as Bucket[]).map((b) => (
              <Button key={b} size="sm" variant={bucket === b ? 'secondary' : 'ghost'} onClick={() => setBucket(b)}>
                {b === 'day' ? 'Days' : b === 'week' ? 'Weeks' : 'Months'}
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              Direction
            </span>
            {([
              { key: 'all', label: 'All cash' },
              { key: 'in', label: 'Money coming in' },
              { key: 'out', label: 'Money going out' },
            ] as const).map((f) => (
              <Button
                key={f.key}
                size="sm"
                variant={flowFilter === f.key ? 'secondary' : 'ghost'}
                onClick={() => setFlowFilter(f.key)}
              >
                {f.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Category buttons */}
      {isLoading ? (
        <Skeleton className="h-24 w-full rounded-xl" />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {categories.map((c) => (
            <button
              key={c.key}
              onClick={() => setActiveCat(c.key)}
              className={cn(
                'rounded-xl border p-3 text-left transition-all hover:shadow-sm',
                active?.key === c.key ? 'border-primary bg-primary/5' : 'border-border',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold">{c.label}</p>
                <div className="flex items-center gap-1 shrink-0">
                  <Badge
                    variant="outline"
                    className={cn(
                      'text-[9px]',
                      (c.flow ?? 'out') === 'in'
                        ? 'border-emerald-500/50 text-emerald-600'
                        : 'border-rose-500/50 text-rose-600',
                    )}
                  >
                    {(c.flow ?? 'out') === 'in' ? 'In' : 'Out'}
                  </Badge>
                  <Badge variant={c.kind === 'forecast' ? 'default' : 'outline'} className="text-[9px]">
                    {c.kind === 'forecast' ? 'Forecast' : 'Actual'}
                  </Badge>
                </div>
              </div>
              <p className="mt-1 text-base font-bold font-mono tabular-nums">{formatUGX(Number(c.total))}</p>
              <p className="text-[10px] text-muted-foreground">{Number(c.count)} entries in window</p>
            </button>
          ))}
        </div>
      )}

      {/* Graph */}
      <Card>
        <CardContent className="p-4 space-y-3">
          {isLoading ? (
            <Skeleton className="h-72 w-full rounded-xl" />
          ) : !active ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No payout activity in this window.
            </p>
          ) : (
            <>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <h2 className="text-sm font-bold flex items-center gap-1.5">
                    <TrendingUp className="h-4 w-4 text-primary" />
                    {active.label}
                  </h2>
                  <p className="text-[11px] text-muted-foreground">
                    {isInflow ? 'Cash coming in' : 'Cash going out'} ·{' '}
                    Amount vs time · {bucket === 'day' ? 'daily' : bucket === 'week' ? 'weekly' : 'monthly'} buckets
                    {' · '}
                    {isoDay(start)} to {isoDay(end)}
                  </p>
                </div>
                <div className="flex gap-4 text-right">
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Total</p>
                    <p className="text-sm font-bold font-mono tabular-nums">{formatUGX(total)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Peak</p>
                    <p className="text-sm font-bold font-mono tabular-nums">{formatUGX(peak)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Average</p>
                    <p className="text-sm font-bold font-mono tabular-nums">{formatUGX(Math.round(avg))}</p>
                  </div>
                </div>
              </div>

              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  {active.kind === 'forecast' ? (
                    <AreaChart data={chartData}>
                      <defs>
                        <linearGradient id="cfFcGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={isInflow ? 'hsl(152 60% 40%)' : 'hsl(var(--primary))'} stopOpacity={0.35} />
                          <stop offset="95%" stopColor={isInflow ? 'hsl(152 60% 40%)' : 'hsl(var(--primary))'} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                      <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 10 }} width={70} tickFormatter={(v) => new Intl.NumberFormat('en-UG').format(Number(v))} />
                      <Tooltip content={<CustomTooltip />} />
                      <Area
                        type="monotone"
                        dataKey="amount"
                        stroke={isInflow ? 'hsl(152 60% 40%)' : 'hsl(var(--primary))'}
                        strokeWidth={2}
                        fill="url(#cfFcGrad)"
                      />
                    </AreaChart>
                  ) : (
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                      <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 10 }} width={70} tickFormatter={(v) => new Intl.NumberFormat('en-UG').format(Number(v))} />
                      <Tooltip content={<CustomTooltip />} />
                      <Bar dataKey="amount" fill={isInflow ? 'hsl(152 60% 40%)' : 'hsl(var(--primary))'} radius={[3, 3, 0, 0]} />
                    </BarChart>
                  )}
                </ResponsiveContainer>
              </div>

              <p className="text-[11px] text-muted-foreground">
                Outflow forecasts project every active portfolio&apos;s monthly Returns cycle forward from its
                next Returns date up to maturity, so Partner Ops approvals, top-ups, compounding and
                withdrawals immediately reshape the curve. Inflow forecasts schedule each funded tenant&apos;s
                remaining receivable at its daily repayment rate and each unpaused agent advance at its daily
                installment, so receivable cash is projected day by day until the balance clears. Actual panels
                read posted ledger movements in the matching direction.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* Forecast vs actually paid, receivables, top-ups, promissory, compounding */}
      {active?.key === 'roi_forecast' && (
        <PartnerReturnsForecastPanel start={start} end={end} bucket={bucket} />
      )}

      {/* Per-partner projection (Returns forecast only) */}
      {active?.key === 'roi_forecast' && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <h2 className="text-sm font-bold">Projection per partner</h2>
                <p className="text-[11px] text-muted-foreground">
                  Every partner whose Partner Ops portfolios fall due inside {isoDay(start)} to {isoDay(end)}.
                </p>
              </div>
              <Badge variant="outline" className="text-[10px]">{partners.length} partners</Badge>
            </div>

            {partners.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No partner Returns fall due inside this window.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                      <th className="py-2 pr-3 font-semibold">Partner</th>
                      <th className="py-2 pr-3 font-semibold">Portfolios</th>
                      <th className="py-2 pr-3 font-semibold text-right">Committed</th>
                      <th className="py-2 pr-3 font-semibold">Next payout</th>
                      <th className="py-2 pr-3 font-semibold">Cycles</th>
                      <th className="py-2 font-semibold text-right">Projected Returns</th>
                    </tr>
                  </thead>
                  <tbody>
                    {partners.map((p) => (
                      <tr key={p.partner_id} className="border-t border-border/60">
                        <td className="py-2 pr-3">
                          <p className="font-semibold">{p.partner_name}</p>
                          {p.phone ? <p className="text-[10px] text-muted-foreground">{p.phone}</p> : null}
                        </td>
                        <td className="py-2 pr-3 tabular-nums">{Number(p.portfolios)}</td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums">
                          {formatUGX(Number(p.committed))}
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap">{p.next_due ?? '—'}</td>
                        <td className="py-2 pr-3 tabular-nums">{Number(p.payouts)}</td>
                        <td className="py-2 text-right font-mono tabular-nums font-bold">
                          {formatUGX(Number(p.projected))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-border">
                      <td className="py-2 pr-3 font-bold" colSpan={5}>Total projected Returns</td>
                      <td className="py-2 text-right font-mono tabular-nums font-bold">
                        {formatUGX(partners.reduce((s, p) => s + Number(p.projected), 0))}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default CashflowForecastGraphs;