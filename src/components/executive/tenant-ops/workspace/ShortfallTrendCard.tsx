/**
 * Is the collection shortfall improving? One bar per Kampala day for short UGX and a line
 * for the percentage of that day's bill collected, over the last 7 / 30 / 90 days.
 * Every figure comes from tops_shortfall_daily_trend; this card never feeds the page header.
 */
import { useState } from 'react';
import { format, parseISO } from 'date-fns';
import { AlertTriangle } from 'lucide-react';
import { Bar, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, type ChartConfig } from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';
import { useShortfallTrend, type ShortfallTrendDays, type ShortfallTrendPoint } from '@/hooks/tenantOpsWorkspace/useShortfallTrend';

const WINDOWS: ShortfallTrendDays[] = [7, 30, 90];

const CHART_CONFIG = {
  short_ugx: { label: 'Short', color: 'hsl(var(--destructive))' },
  covered_pct: { label: 'Covered', color: 'hsl(var(--primary))' },
} satisfies ChartConfig;

const fmtDay = (iso: string) => format(parseISO(iso), 'd MMM');
const fmtPct = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)}%`);
/** Axis label only: 6,500,000 -> "6.5M". The exact UGX is in the tooltip. */
const fmtAxisUgx = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n));

function TrendTooltip({
  active, payload, todayIso,
}: {
  active?: boolean;
  payload?: { payload: ShortfallTrendPoint }[];
  todayIso: string | undefined;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-border bg-popover p-2.5 text-xs shadow-md">
      <p className="font-semibold">
        {format(parseISO(p.day), 'EEE d MMM yyyy')}
        {p.day === todayIso && <span className="font-normal text-muted-foreground"> · today so far</span>}
      </p>
      <dl className="mt-1.5 space-y-0.5">
        <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Short</dt><dd className="font-semibold tabular-nums text-destructive">{formatUGX(p.short_ugx)}</dd></div>
        <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Covered</dt><dd className="font-semibold tabular-nums">{fmtPct(p.covered_pct)}</dd></div>
        <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Expected</dt><dd className="tabular-nums">{formatUGX(p.expected_ugx)}</dd></div>
        <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Collected</dt><dd className="tabular-nums">{formatUGX(p.collected_ugx)}</dd></div>
        <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Rent Plans short</dt><dd className="tabular-nums">{p.short_plans}</dd></div>
      </dl>
    </div>
  );
}

export function ShortfallTrendCard() {
  const [days, setDays] = useState<ShortfallTrendDays>(30);
  const { data, isLoading, isError, isFetching } = useShortfallTrend(days);
  const points = data ?? [];
  const today = points.length ? points[points.length - 1].day : undefined;
  // Days before the daily bill existed carry no information; don't draw a flat run of zeros.
  const billed = points.filter((p) => p.expected_ugx > 0);

  return (
    <Card>
      <CardHeader className="space-y-2 pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base">Is the shortfall improving?</CardTitle>
            <CardDescription>Short UGX per day and the share of each day&apos;s bill collected. The last day is today, so far.</CardDescription>
          </div>
          <div role="group" aria-label="Trend window" className="flex gap-1.5">
            {WINDOWS.map((w) => (
              <Button
                key={w}
                type="button"
                size="sm"
                variant={days === w ? 'default' : 'outline'}
                aria-pressed={days === w}
                className="h-9 min-w-14 text-xs"
                onClick={() => setDays(w)}
              >
                {w} days
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-52 w-full" />
        ) : isError ? (
          <div role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Could not load the trend. Check your connection and try again.
          </div>
        ) : billed.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">No Rent Plans were billed in these days.</p>
        ) : (
          <div className={isFetching ? 'opacity-70' : undefined}>
            <ChartContainer config={CHART_CONFIG} className="aspect-auto h-52 w-full" role="img" aria-label={`Short UGX and percent covered per day, last ${days} days`}>
              <ComposedChart data={billed} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="day" tickFormatter={fmtDay} tick={{ fontSize: 10 }} minTickGap={18} tickMargin={6} />
                <YAxis yAxisId="ugx" tickFormatter={fmtAxisUgx} tick={{ fontSize: 10 }} width={38} />
                <YAxis yAxisId="pct" orientation="right" domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 10 }} width={34} />
                <Tooltip content={<TrendTooltip todayIso={today} />} cursor={{ fill: 'hsl(var(--muted) / 0.5)' }} />
                <Bar yAxisId="ugx" dataKey="short_ugx" fill="var(--color-short_ugx)" radius={[3, 3, 0, 0]} maxBarSize={22} isAnimationActive={false} />
                <Line yAxisId="pct" dataKey="covered_pct" type="monotone" stroke="var(--color-covered_pct)" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
              </ComposedChart>
            </ChartContainer>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-destructive" /> Short UGX</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-3 bg-primary" /> % of the day&apos;s bill collected</span>
            </div>
            <div className="sr-only">
            <table data-testid="shortfall-trend-data">
              <caption>Shortfall per day, last {days} days</caption>
              <thead><tr><th>Day</th><th>Short</th><th>Covered</th><th>Rent Plans short</th></tr></thead>
              <tbody>
                {billed.map((p) => (
                  <tr key={p.day}><td>{p.day}</td><td>{formatUGX(p.short_ugx)}</td><td>{fmtPct(p.covered_pct)}</td><td>{p.short_plans}</td></tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
