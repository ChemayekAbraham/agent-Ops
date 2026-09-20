import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatDynamic } from '@/lib/currencyFormat';
import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronDown, LineChart } from 'lucide-react';
import { useEmptyHouseTrend, type TrendBucket, type TrendPoint, type TrendRegion } from '@/hooks/useEmptyHouseTrend';

interface Props {
  /** Optional filters carried over from the house feed. */
  district?: string | null;
  minRent?: number | null;
  maxRent?: number | null;
}

type Metric = 'count' | 'rent';

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (days: number) => isoDay(new Date(Date.now() - days * 86_400_000));

const RANGES: { value: string; label: string; days: number; bucket: TrendBucket }[] = [
  { value: '30', label: 'Last 30 days', days: 30, bucket: 'day' },
  { value: '90', label: 'Last 3 months', days: 90, bucket: 'week' },
  { value: '180', label: 'Last 6 months', days: 180, bucket: 'week' },
  { value: '365', label: 'Last 12 months', days: 365, bucket: 'month' },
];

const shortDate = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

const valueOf = (point: TrendPoint, metric: Metric) =>
  metric === 'count' ? point.emptyCount : point.rentNeeded;

const formatValue = (value: number, metric: Metric) =>
  metric === 'count' ? value.toLocaleString() : formatDynamic(value);

/** Tiny inline chart: no chart library, no layout cost on a phone. */
function Sparkline({ series, metric }: { series: TrendPoint[]; metric: Metric }) {
  const values = series.map((p) => valueOf(p, metric));
  if (values.length < 2) return <div className="h-8 w-full rounded bg-muted/40" aria-hidden />;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - min) / span) * 26}`)
    .join(' ');
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-8 w-full" aria-hidden>
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        className="text-primary"
      />
    </svg>
  );
}

function ChangeBadge({ change, metric }: { change: number; metric: Metric }) {
  if (change === 0) {
    return (
      <Badge variant="secondary" className="rounded-full text-[10px] font-bold">
        <ArrowRight className="mr-1 h-3 w-3" aria-hidden /> No change
      </Badge>
    );
  }
  const up = change > 0;
  return (
    <Badge
      variant="secondary"
      className={`rounded-full text-[10px] font-bold ${up ? 'text-amber-600' : 'text-emerald-600'}`}
    >
      {up ? <ArrowUpRight className="mr-1 h-3 w-3" aria-hidden /> : <ArrowDownRight className="mr-1 h-3 w-3" aria-hidden />}
      {up ? '+' : '−'}
      {formatValue(Math.abs(change), metric)}
    </Badge>
  );
}

export function EmptyHouseTrendPanel({ district, minRent, maxRent }: Props) {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState('90');
  const [metric, setMetric] = useState<Metric>('count');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  const preset = RANGES.find((r) => r.value === range) ?? RANGES[1];
  const custom = range === 'custom' && customStart && customEnd;
  const start = custom ? customStart : daysAgo(preset.days);
  const end = custom ? customEnd : isoDay(new Date());
  const bucket: TrendBucket = custom
    ? (() => {
        const days = Math.max(1, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86_400_000));
        if (days <= 45) return 'day';
        if (days <= 400) return 'week';
        return 'month';
      })()
    : preset.bucket;

  const { data, isLoading, isError, refetch } = useEmptyHouseTrend(
    { start, end, bucket, district, minRent, maxRent },
    open,
  );

  const totals = data?.totals ?? [];
  const totalFirst = totals.length ? valueOf(totals[0], metric) : 0;
  const totalLast = totals.length ? valueOf(totals[totals.length - 1], metric) : 0;
  const totalChange = totalLast - totalFirst;

  const regions = useMemo<TrendRegion[]>(() => {
    const list = [...(data?.regions ?? [])];
    return list.sort((a, b) =>
      metric === 'count' ? b.lastCount - a.lastCount : b.lastRent - a.lastRent,
    );
  }, [data?.regions, metric]);

  const bucketLabel = bucket === 'day' ? 'day' : bucket === 'month' ? 'month' : 'week';

  return (
    <Card className="rounded-xl p-3 sm:rounded-2xl sm:p-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="empty-house-trends"
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span className="flex items-center gap-2">
          <LineChart className="h-4 w-4 text-primary" aria-hidden />
          <span>
            <span className="block text-sm font-black text-foreground">
              How empty houses and rent needed are changing
            </span>
            <span className="block text-[11px] font-medium text-muted-foreground">
              Compare areas over any period you choose
            </span>
          </span>
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>

      {open && (
        <div id="empty-house-trends" className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={range} onValueChange={setRange}>
              <SelectTrigger className="h-9 w-auto min-w-[150px] text-xs font-semibold" aria-label="Choose a period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Pick my own dates</SelectItem>
              </SelectContent>
            </Select>
            <Select value={metric} onValueChange={(v) => setMetric(v as Metric)}>
              <SelectTrigger className="h-9 w-auto min-w-[150px] text-xs font-semibold" aria-label="Choose what to compare">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="count">Number of empty houses</SelectItem>
                <SelectItem value="rent">Rent needed</SelectItem>
              </SelectContent>
            </Select>
            {range === 'custom' && (
              <div className="flex items-center gap-2">
                <Input
                  type="date"
                  value={customStart}
                  max={customEnd || isoDay(new Date())}
                  onChange={(e) => setCustomStart(e.target.value)}
                  className="h-9 w-[9.5rem] text-xs font-semibold"
                  aria-label="Start date"
                />
                <span className="text-xs text-muted-foreground">to</span>
                <Input
                  type="date"
                  value={customEnd}
                  min={customStart || undefined}
                  max={isoDay(new Date())}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  className="h-9 w-[9.5rem] text-xs font-semibold"
                  aria-label="End date"
                />
              </div>
            )}
          </div>

          {range === 'custom' && !custom && (
            <p className="text-xs text-muted-foreground">Choose a start and end date to see the comparison.</p>
          )}

          {isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full rounded-xl" />
              <Skeleton className="h-16 w-full rounded-xl" />
            </div>
          )}

          {isError && (
            <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3">
              <p className="text-xs font-semibold text-foreground">We could not load the history just now.</p>
              <Button size="sm" variant="outline" className="mt-2 h-8 text-xs" onClick={() => void refetch()}>
                Try again
              </Button>
            </div>
          )}

          {!isLoading && !isError && data && (
            <>
              <div className="rounded-xl border border-border bg-muted/30 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-[11px] font-semibold text-muted-foreground">
                      {metric === 'count' ? 'Empty houses waiting' : 'Rent needed for empty houses'} — all areas
                    </p>
                    <p className="text-lg font-black text-foreground">{formatValue(totalLast, metric)}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {shortDate(start)} to {shortDate(end)} · measured every {bucketLabel} · was{' '}
                      {formatValue(totalFirst, metric)} at the start
                    </p>
                  </div>
                  <ChangeBadge change={totalChange} metric={metric} />
                </div>
                <div className="mt-2">
                  <Sparkline series={totals} metric={metric} />
                </div>
              </div>

              {regions.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No empty houses were listed in this period for the filters you picked.
                </p>
              ) : (
                <div className="space-y-2">
                  <p className="px-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                    Area by area
                  </p>
                  {regions.map((region) => {
                    const last = metric === 'count' ? region.lastCount : region.lastRent;
                    const first = metric === 'count' ? region.firstCount : region.firstRent;
                    const change = metric === 'count' ? region.countChange : region.rentChange;
                    return (
                      <div
                        key={region.region}
                        className="rounded-xl border border-border bg-background p-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-bold text-foreground">{region.region}</p>
                            <p className="text-[10px] text-muted-foreground">
                              now {formatValue(last, metric)} · started at {formatValue(first, metric)}
                            </p>
                          </div>
                          <ChangeBadge change={change} metric={metric} />
                        </div>
                        <div className="mt-1.5">
                          <Sparkline series={region.series} metric={metric} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <p className="px-1 text-[10px] leading-relaxed text-muted-foreground">
                The figures rise when agents list new empty houses and fall when Supporters fund them, so a
                falling line means the area is being taken up quickly.
              </p>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
