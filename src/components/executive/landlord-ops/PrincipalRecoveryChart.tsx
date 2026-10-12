import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { formatUGX } from '@/lib/rentCalculations';

export interface PrincipalComparison {
  as_of: string;
  expected: number;
  recovered: number;
  monthly: boolean;
  trend: Array<{ date: string; expected: number; recovered: number }>;
}

export function PrincipalRecoveryChart({ comparison }: { comparison: PrincipalComparison }) {
  const singleDay = comparison.trend.length === 1 ? comparison.trend[0] : undefined;
  // Extend a single daily snapshot across the plot, without inventing intraday movements.
  const chartData = singleDay
    ? [{ ...singleDay, plotPosition: 0 }, { ...singleDay, plotPosition: 1 }]
    : comparison.trend;
  const dateLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    timeZone: 'UTC', month: 'short', ...(comparison.monthly ? { year: '2-digit' } : { day: 'numeric' }),
  });
  return (
    <section className="space-y-4 border-y border-border py-5" aria-label="Expected versus recovered principal">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Expected vs recovered principal</h2>
          <p className="mt-1 text-xs text-muted-foreground">Cumulative totals · Kampala dates · Returned float and reversed repayments excluded</p>
        </div>
        <div className="flex flex-wrap gap-4 text-xs">
          <span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-chart-1" />Expected</span>
          <span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-chart-2" />Recovered</span>
        </div>
      </div>
      <ChartContainer className="h-[300px] w-full aspect-auto" config={{
        expected: { label: 'Expected', color: 'hsl(var(--chart-1))' },
        recovered: { label: 'Recovered', color: 'hsl(var(--chart-2))' },
      }}>
        <AreaChart accessibilityLayer data={chartData} margin={{ top: 12, right: 12, bottom: 8, left: 0 }}>
          <CartesianGrid vertical={false} />
          {singleDay ? (
            <XAxis dataKey="plotPosition" type="number" domain={[0, 1]} ticks={[0.5]} tickFormatter={() => dateLabel(singleDay.date)} tickLine={false} axisLine={false} />
          ) : (
            <XAxis dataKey="date" tickFormatter={dateLabel} minTickGap={30} tickLine={false} axisLine={false} />
          )}
          <YAxis width={80} tickLine={false} axisLine={false} tickFormatter={(value: number) => `UGX ${value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(0)}K` : value}`} />
          <ChartTooltip content={<ChartTooltipContent labelFormatter={(label) => dateLabel(singleDay?.date ?? String(label))} formatter={(value, name) => (
            <div className="flex w-full justify-between gap-4"><span className="text-muted-foreground">{name === 'expected' ? 'Expected' : 'Recovered'}</span><span className="font-medium tabular-nums">{formatUGX(Number(value))}</span></div>
          )} />} />
          <Area type="monotone" dataKey="expected" stroke="var(--color-expected)" fill="var(--color-expected)" fillOpacity={0.12} strokeWidth={2} dot={false} isAnimationActive={false} />
          <Area type="monotone" dataKey="recovered" stroke="var(--color-recovered)" fill="var(--color-recovered)" fillOpacity={0.16} strokeWidth={2} dot={false} isAnimationActive={false} />
        </AreaChart>
      </ChartContainer>
      <div className="flex flex-wrap justify-between gap-2 text-sm">
        <span className="text-muted-foreground">Principal still to recover</span>
        <span className="font-semibold tabular-nums">{formatUGX(Math.max(0, comparison.expected - comparison.recovered))}</span>
      </div>
    </section>
  );
}