import { Activity, CheckCircle2, Clock3, RotateCcw, UserRound, ShieldCheck } from 'lucide-react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import type { KycOverview as Overview } from '@/hooks/useAgentVettingQueue';
import type { VettingStatus } from '@/lib/agentVetting';

export const KYC_STATUSES = [
  { value: 'submitted', label: 'Awaiting review', icon: Clock3, tone: 'text-warning', band: 'bg-warning/10' },
  { value: 'verified', label: 'Verified', icon: CheckCircle2, tone: 'text-success', band: 'bg-success/10' },
  { value: 'rejected', label: 'Sent back', icon: RotateCcw, tone: 'text-destructive', band: 'bg-destructive/10' },
  { value: 'unverified', label: 'Not started', icon: UserRound, tone: 'text-muted-foreground', band: 'bg-muted' },
] as const;

const chartConfig = {
  submitted: { label: 'Submitted', color: 'hsl(var(--chart-1))' },
  approved: { label: 'Approved', color: 'hsl(var(--success))' },
  rejected: { label: 'Sent back', color: 'hsl(var(--destructive))' },
};
const dateLabel = (day: string) => new Date(`${day}T12:00:00+03:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Kampala' });

export default function KycOverview({ data, loading, error, counts, status, onStatus, days, onDays, onRetry }: {
  data?: Overview; loading: boolean; error: boolean;
  counts?: Record<VettingStatus, number>; status: VettingStatus; onStatus: (s: string) => void;
  days: 7 | 30; onDays: (days: 7 | 30) => void; onRetry: () => void;
}) {
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  const hasEvents = data?.series.some((d) => d.submitted + d.approved + d.rejected > 0);
  return <>
    <section aria-label="Verification totals" className="grid grid-cols-2 border-y border-border lg:grid-cols-4">
      {KYC_STATUSES.map(({ value, label, icon: Icon, tone, band }) => <Button key={value} variant="ghost" onClick={() => onStatus(value)} aria-pressed={status === value}
        className={`h-auto min-h-32 justify-start rounded-none border-b border-border px-4 py-5 text-left sm:px-6 lg:border-b-0 ${status === value ? 'bg-muted/60' : ''}`}>
        <div className="w-full space-y-3"><div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-muted-foreground sm:text-sm">{label}</span><span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${band} ${tone}`}><Icon className="h-4 w-4" /></span></div>
          <div className="text-3xl font-semibold tabular-nums">{counts ? (counts[value] ?? 0).toLocaleString() : <Skeleton className="h-9 w-16" />}</div>
        </div>
      </Button>)}
    </section>
    <section className="grid min-w-0 gap-8 border-b border-border py-7 lg:grid-cols-[minmax(0,1fr)_260px]" aria-label="Verification analytics">
      <div className="min-w-0"><div className="mb-5 flex flex-wrap items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 text-base font-semibold"><Activity className="h-4 w-4 text-muted-foreground" />Verification activity</h2><p className="mt-1 text-xs text-muted-foreground">Daily decisions · Kampala time</p></div>
        <div className="flex gap-1 rounded-md bg-muted p-1" aria-label="Activity period">{([7, 30] as const).map((period) => <Button key={period} variant={days === period ? 'secondary' : 'ghost'} size="sm" aria-pressed={days === period} className="min-h-10" onClick={() => onDays(period)}>{period} days</Button>)}</div></div>
        {loading ? <Skeleton className="h-56 w-full" /> : error ? <div className="flex h-56 flex-col items-center justify-center gap-3 text-sm text-muted-foreground"><p>Verification activity unavailable.</p><Button variant="outline" onClick={onRetry}>Retry</Button></div> : data ? <>
          <ChartContainer config={chartConfig} className="h-56 w-full aspect-auto" aria-label={`Daily verification events over ${days} days`}>
            <LineChart accessibilityLayer data={data.series} margin={{ top: 10, right: 12, left: -24, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="3 3" />
              <XAxis dataKey="day" tickFormatter={dateLabel} axisLine={false} tickLine={false} minTickGap={32} tickMargin={12} />
              <YAxis allowDecimals={false} axisLine={false} tickLine={false} tickMargin={8} domain={[0, 'auto']} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(value) => dateLabel(String(value))} />} />
              {(['submitted', 'approved', 'rejected'] as const).map((key) => <Line key={key} type="linear" dataKey={key} stroke={`var(--color-${key})`} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />)}
            </LineChart>
          </ChartContainer>
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground"><span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-chart-1" />Submitted</span><span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-success" />Approved</span><span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-destructive" />Sent back</span>{!hasEvents && <span>No recorded decisions in this period.</span>}</div>
        </> : <p className="py-20 text-center text-sm text-muted-foreground">No activity data available.</p>}
      </div>
      <div className="lg:border-l lg:border-border lg:pl-7"><h2 className="flex items-center gap-2 text-base font-semibold"><ShieldCheck className="h-4 w-4 text-muted-foreground" />Verification coverage</h2><p className="mt-1 text-xs text-muted-foreground">Current agent status</p><p className="mt-5 text-4xl font-semibold tabular-nums">{counts ? `${total ? Math.round((counts.verified ?? 0) / total * 100) : 0}%` : '—'}</p><p className="mt-1 text-xs text-muted-foreground">verified · {counts ? total.toLocaleString() : '—'} agents</p>
        <div className="mt-5 space-y-3">{KYC_STATUSES.map(({ value, label, tone }) => <div key={value} className="flex items-center justify-between gap-3 text-sm"><span className={tone}>{label}</span><span className="font-medium tabular-nums">{counts ? (counts[value] ?? 0).toLocaleString() : '—'}</span></div>)}</div>
      </div>
    </section>
  </>;
}