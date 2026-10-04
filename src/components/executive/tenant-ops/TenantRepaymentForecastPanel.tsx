import { useMemo, useState } from 'react';
import { addDays, endOfDay, format, startOfDay } from 'date-fns';
import type { DateRange } from 'react-day-picker';
import { CalendarIcon, CalendarRange, Clock3, AlertTriangle, Users, ArrowUpRight } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { useTenantRepaymentForecast } from '@/hooks/useTenantRepaymentForecast';

type ForecastPreset = 'tomorrow' | 'seven' | 'thirty' | 'custom';

function kampalaToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kampala',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

function toDate(date: string) {
  return new Date(`${date}T12:00:00`);
}

function getDefaultWindow(preset: ForecastPreset, custom?: DateRange) {
  const today = toDate(kampalaToday());
  if (preset === 'tomorrow') {
    const tomorrow = addDays(today, 1);
    return { start: startOfDay(tomorrow), end: endOfDay(tomorrow) };
  }
  if (preset === 'seven') {
    return { start: startOfDay(addDays(today, 1)), end: endOfDay(addDays(today, 7)) };
  }
  if (preset === 'thirty') {
    return { start: startOfDay(addDays(today, 1)), end: endOfDay(addDays(today, 30)) };
  }
  const start = custom?.from ?? addDays(today, 1);
  return { start: startOfDay(start), end: endOfDay(custom?.to ?? start) };
}

function compactDate(date: string) {
  return format(toDate(date), 'dd MMM');
}

interface ForecastMetricProps {
  label: string;
  value: string;
  detail: string;
  icon: typeof Clock3;
  tone: string;
}

function ForecastMetric({ label, value, detail, icon: Icon, tone }: ForecastMetricProps) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <span className={cn('rounded-lg p-1.5', tone)}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      <p className="mt-2 text-lg font-bold tabular-nums text-foreground">{value}</p>
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{detail}</p>
    </div>
  );
}

export function TenantRepaymentForecastPanel() {
  const [preset, setPreset] = useState<ForecastPreset>('seven');
  const [custom, setCustom] = useState<DateRange | undefined>();
  const { start, end } = useMemo(() => getDefaultWindow(preset, custom), [preset, custom]);
  const startIso = format(start, 'yyyy-MM-dd');
  const endIso = format(end, 'yyyy-MM-dd');
  const { data, isLoading, isError } = useTenantRepaymentForecast(startIso, endIso);

  const chartData = useMemo(
    () => (data?.daily ?? []).map((row) => ({
      ...row,
      label: compactDate(row.day),
      projected: row.scheduled_ugx,
      collected: row.collected_ugx ?? 0,
    })),
    [data],
  );
  const rate = data?.collection_rate_pct;
  const customLabel = custom?.from
    ? `${format(custom.from, 'dd MMM')}${custom.to ? ` – ${format(custom.to, 'dd MMM')}` : ''}`
    : 'Pick dates';

  return (
    <Card className="border-primary/20 shadow-sm">
      <CardHeader className="gap-3 px-3 pb-3 sm:px-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <CalendarRange className="h-4 w-4 text-primary" />
              Forward repayment forecast
            </CardTitle>
            <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
              Expected collections from funded, active rent plans in the selected future window.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Select value={preset} onValueChange={(value) => setPreset(value as ForecastPreset)}>
              <SelectTrigger className="h-8 w-[138px] text-xs" aria-label="Forecast period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tomorrow">Tomorrow</SelectItem>
                <SelectItem value="seven">Next 7 days</SelectItem>
                <SelectItem value="thirty">Next 30 days</SelectItem>
                <SelectItem value="custom">Custom range</SelectItem>
              </SelectContent>
            </Select>
            {preset === 'custom' && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="outline" className="h-8 text-xs">
                    <CalendarIcon className="mr-1 h-3.5 w-3.5" />
                    {customLabel}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="end">
                  <Calendar
                    mode="range"
                    numberOfMonths={2}
                    selected={custom}
                    onSelect={setCustom}
                    disabled={{ before: addDays(toDate(kampalaToday()), 1) }}
                    initialFocus
                    className="pointer-events-auto p-3"
                  />
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {compactDate(startIso)} – {compactDate(endIso)} · Africa/Kampala time
        </p>
      </CardHeader>
      <CardContent className="space-y-4 px-3 pb-4 sm:px-4">
        {isLoading ? (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-24 rounded-xl" />)}
            </div>
            <Skeleton className="h-[220px] w-full rounded-xl" />
          </div>
        ) : isError || !data ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            The repayment forecast could not be loaded. Please try again shortly.
          </div>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <ForecastMetric
                label="Projected"
                value={formatUGX(data.expected_ugx)}
                detail={`${data.days} days of scheduled obligations`}
                icon={ArrowUpRight}
                tone="bg-primary/10 text-primary"
              />
              <ForecastMetric
                label="Collected"
                value={formatUGX(data.collected_ugx)}
                detail={data.expected_to_date_ugx > 0 ? `${formatUGX(data.expected_to_date_ugx)} due so far` : 'No days elapsed in this window'}
                icon={Clock3}
                tone="bg-success/10 text-success"
              />
              <ForecastMetric
                label="Collection rate"
                value={rate == null ? '—' : `${rate.toFixed(1)}%`}
                detail={data.shortfall_to_date_ugx > 0 ? `${formatUGX(data.shortfall_to_date_ugx)} short so far` : 'No elapsed shortfall'}
                icon={Users}
                tone="bg-warning/10 text-warning"
              />
              <ForecastMetric
                label="Overdue backlog"
                value={formatUGX(data.overdue_ugx)}
                detail={`${data.overdue_plans.toLocaleString('en-US')} active plans owing before this window`}
                icon={AlertTriangle}
                tone="bg-destructive/10 text-destructive"
              />
            </div>

            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_240px]">
              <div className="min-w-0 rounded-xl border border-border/60 p-2 sm:p-3">
                <div className="mb-2 flex items-center justify-between gap-2 px-1">
                  <p className="text-xs font-semibold text-foreground">Daily collection plan</p>
                  <p className="text-[10px] text-muted-foreground">Bars show UGX</p>
                </div>
                <div className="h-[220px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                      <XAxis dataKey="label" tick={{ fontSize: 10 }} className="fill-muted-foreground" interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" tickFormatter={(value) => `${Math.round(Number(value) / 1000)}k`} />
                      <Tooltip
                        contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px', fontSize: '12px' }}
                        formatter={(value: number, name: string) => [formatUGX(value), name === 'projected' ? 'Projected' : 'Collected']}
                        labelFormatter={(_, payload) => payload?.[0]?.payload?.day ?? ''}
                      />
                      <Bar dataKey="projected" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="collected" fill="hsl(var(--success))" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="space-y-2 rounded-xl border border-border/60 p-3">
                <p className="text-xs font-semibold text-foreground">What drives the projection</p>
                <DriverRow label="Active rent plans" value={data.drivers.active_plans.toLocaleString('en-US')} />
                <DriverRow label="Average daily obligation" value={formatUGX(data.drivers.avg_daily_ugx)} />
                <DriverRow label="New plans in window" value={`${data.drivers.starting_plans} · ${formatUGX(data.drivers.starting_daily_ugx)}/day`} />
                <DriverRow label="Plans ending in window" value={`${data.drivers.ending_plans} · ${formatUGX(data.drivers.ending_daily_ugx)}/day`} />
                <div className="border-t border-border/60 pt-2">
                  <DriverRow label="Remaining obligation" value={formatUGX(data.drivers.remaining_obligation_ugx)} />
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1 rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-[11px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <span><strong className="text-foreground">Overdue</strong> is kept separate from normal future expectations.</span>
              <span>Backlog measured through {compactDate(data.overdue_as_of)}.</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DriverRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  );
}

export default TenantRepaymentForecastPanel;
