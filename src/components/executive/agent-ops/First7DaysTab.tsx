import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { format, parseISO } from 'date-fns';
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts';
import { AlertTriangle, CalendarClock, CheckCircle2, Clock, Loader2, RefreshCw, Search, Sprout, TrendingDown, Users, X, Hourglass } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import { Skeleton, SkeletonChart, SkeletonMetricCard, SkeletonTable } from '@/components/ui/skeleton';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { useIsMobile } from '@/hooks/use-mobile';
import { useNewTenantFirst7 } from '@/hooks/useNewTenantFirst7';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import {
  DAY_STATE_LABEL,
  PRESETS,
  STATUS_LABEL,
  addDays,
  clampRange,
  filterFirst7Rows,
  first7ErrorMessage,
  kampalaToday,
  presetOf,
  presetRange,
  readFirst7Params,
  sortFirst7Rows,
  writeFirst7Params,
  type CardFilter,
  type DayState,
  type First7Params,
  type First7Row,
  type First7Summary,
  type FrequencyFilter,
  type RowStatus,
} from '@/lib/newTenantFirst7';

const PAGE = 50;
const FREQ_LABEL: Record<FrequencyFilter, string> = { all: 'All', daily: 'Daily', weekly: 'Weekly' };
const fmtDay = (iso: string) => format(parseISO(iso), 'd MMM');

// ---------- how a day looks ----------

type CellKind = DayState;

/** What a day cell shows. The state comes from the server; a day with nothing due is "not due" (weekly days 2 to 7). */
function cellKind(r: First7Row, i: number): CellKind {
  const state = r.day_state[i] ?? 'future';
  const paid = r.day_paid[i] ?? 0;
  if (paid > 0 && (state === 'paid' || state === 'part')) return state;
  if ((r.day_due[i] ?? 0) === 0) return 'not_due';
  return state;
}

const CELL_TONE: Record<CellKind, string> = {
  paid: 'bg-success/15 text-success',
  part: 'bg-warning/15 text-warning',
  missed: 'bg-destructive/15 text-destructive',
  future: 'bg-muted/40 text-muted-foreground',
  not_due: 'border border-dashed border-border bg-transparent text-muted-foreground',
};
const DOT_TONE: Record<CellKind, string> = {
  paid: 'bg-success',
  part: 'bg-warning',
  missed: 'bg-destructive',
  future: 'bg-muted',
  not_due: 'border border-dashed border-muted-foreground/60 bg-transparent',
};
const STATUS_TONE: Record<RowStatus, string> = {
  on_track: 'border-success/20 bg-success/10 text-success',
  behind: 'border-destructive/20 bg-destructive/10 text-destructive',
  not_started: 'border-warning/20 bg-warning/10 text-warning',
  too_early: 'border-border bg-muted/50 text-muted-foreground',
};

function cellText(r: First7Row, i: number, kind: CellKind): string {
  const paid = r.day_paid[i] ?? 0;
  const due = r.day_due[i] ?? 0;
  if (kind === 'not_due') return 'not due';
  if (kind === 'future') return r.frequency === 'weekly' && due > 0 ? `due ${formatUGX(due)}` : '—';
  if (kind === 'missed') return 'Missed';
  return formatUGX(paid);
}

function cellTitle(r: First7Row, i: number, kind: CellKind): string {
  const paid = r.day_paid[i] ?? 0;
  const due = r.day_due[i] ?? 0;
  return [`Day ${i + 1} · ${fmtDay(addDays(r.day1, i))} · ${DAY_STATE_LABEL[kind]}`, due > 0 ? `due ${formatUGX(due)}` : null, paid > 0 ? `paid ${formatUGX(paid)}` : null]
    .filter(Boolean)
    .join(' · ');
}

const isDueDay = (r: First7Row, i: number) => r.frequency === 'weekly' && (r.day_due[i] ?? 0) > 0;

function StatusBadge({ status }: { status: RowStatus }) {
  return <Badge variant="outline" className={cn('whitespace-nowrap text-[10px]', STATUS_TONE[status])}>{STATUS_LABEL[status]}</Badge>;
}

// ---------- summary cards ----------

const CARDS: { id: CardFilter; label: string; icon: typeof Users; tone: string; value: (s: First7Summary) => number; hint: (s: First7Summary) => string }[] = [
  { id: 'all', label: 'New Rent Plans', icon: Users, tone: 'text-primary', value: (s) => s.plans, hint: (s) => `${s.daily_plans} daily · ${s.weekly_plans} weekly` },
  {
    id: 'day1', label: 'Paid on day 1', icon: CalendarClock, tone: 'text-primary', value: (s) => s.day1.payers,
    hint: (s) => (s.day1.pct === null ? 'No day 1 yet' : `${s.day1.pct}% of ${s.day1.started} started`),
  },
  { id: 'on_track', label: 'On track', icon: CheckCircle2, tone: 'text-success', value: (s) => s.status.on_track, hint: () => 'Paid what was due' },
  { id: 'behind', label: 'Behind', icon: TrendingDown, tone: 'text-destructive', value: (s) => s.status.behind, hint: () => 'Paid less than due' },
  { id: 'not_started', label: 'Not started', icon: Hourglass, tone: 'text-warning', value: (s) => s.status.not_started, hint: () => 'Nothing paid yet' },
  { id: 'too_early', label: 'Too early', icon: Clock, tone: 'text-muted-foreground', value: (s) => s.status.too_early, hint: () => 'Day 1 not reached' },
];

function SummaryCards({ summary, active, onPick }: { summary: First7Summary; active: CardFilter; onPick: (c: CardFilter) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
      {CARDS.map(({ id, label, icon: Icon, tone, value, hint }) => {
        const on = active === id;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={on}
            onClick={() => onPick(on ? 'all' : id)}
            className={cn(
              'rounded-xl border bg-card p-3 text-left shadow-2xs transition-all hover:border-primary/50 hover:bg-muted/40',
              on ? 'border-primary ring-2 ring-primary/40' : 'border-border',
            )}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-muted-foreground">{label}</span>
              <Icon className={cn('h-4 w-4', tone)} />
            </span>
            <span className="mt-1 block text-2xl font-bold tabular-nums text-foreground">{value(summary).toLocaleString('en-UG')}</span>
            <span className="block truncate text-[10px] text-muted-foreground">{hint(summary)}</span>
          </button>
        );
      })}
    </div>
  );
}

function CollectedStrip({ summary }: { summary: First7Summary }) {
  const pct = summary.collected_pct;
  return (
    <Card className="space-y-1.5 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="text-xs font-semibold text-foreground">
          Collected {formatUGX(summary.collected)} <span className="font-normal text-muted-foreground">of {formatUGX(summary.expected)} due so far</span>
        </p>
        <p className="text-xs font-bold tabular-nums text-foreground">{pct === null ? 'Nothing due yet' : `${pct}%`}</p>
      </div>
      <Progress value={Math.min(100, pct ?? 0)} />
    </Card>
  );
}

// ---------- Day 1 to 7 chart ----------

const chartConfig: ChartConfig = {
  started: { label: 'Day reached', color: 'hsl(var(--muted-foreground) / 0.3)' },
  payers: { label: 'Paid that day', color: 'hsl(var(--primary))' },
};

function DayChart({ summary, day, onPick }: { summary: First7Summary; day: number | null; onPick: (d: number | null) => void }) {
  const data = Array.from({ length: 7 }, (_, i) => {
    const d = summary.per_day.find((p) => p.day === i + 1);
    return { day: i + 1, name: `Day ${i + 1}`, started: d?.started ?? 0, payers: d?.payers ?? 0 };
  });
  const toggle = (d: number) => onPick(day === d ? null : d);
  return (
    <Card className="space-y-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-bold text-foreground">Who paid on each day</p>
        <p className="text-[10px] text-muted-foreground">Tap a bar to list the plans that paid that day</p>
      </div>
      <ChartContainer config={chartConfig} className="h-44 w-full">
        <BarChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }} barGap={2}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={11} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} fontSize={11} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="started" fill="var(--color-started)" radius={[4, 4, 0, 0]} cursor="pointer" onClick={(d: { day: number }) => toggle(d.day)} />
          <Bar dataKey="payers" fill="var(--color-payers)" radius={[4, 4, 0, 0]} cursor="pointer" onClick={(d: { day: number }) => toggle(d.day)}>
            {data.map((d) => <Cell key={d.day} fillOpacity={day === null || day === d.day ? 1 : 0.35} />)}
          </Bar>
        </BarChart>
      </ChartContainer>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by day">
        {data.map((d) => (
          <button
            key={d.day}
            type="button"
            aria-pressed={day === d.day}
            onClick={() => toggle(d.day)}
            className={cn(
              'rounded-full border px-2 py-0.5 text-[10px] font-medium tabular-nums transition-colors',
              day === d.day ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-muted/50 text-muted-foreground hover:text-foreground',
            )}
          >
            Day {d.day} · {d.payers}/{d.started}
          </button>
        ))}
      </div>
    </Card>
  );
}

// ---------- the grid (desktop) and the cards (mobile) ----------

function RowIdentity({ r }: { r: First7Row }) {
  return (
    <>
      <p className="font-semibold text-foreground">{r.tenant_name ?? '—'}</p>
      <p className="text-muted-foreground">{r.tenant_phone ?? ''}</p>
    </>
  );
}

const planLabel = (r: First7Row) =>
  r.frequency === 'weekly' ? `Weekly · ${formatUGX(r.day_due.find((d) => d > 0) ?? r.daily_due * 7)} / week` : `Daily · ${formatUGX(r.daily_due)} / day`;

function GridTable({ rows }: { rows: First7Row[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1 pr-2">Tenant</th>
            <th className="py-1 pr-2">Agent</th>
            <th className="py-1 pr-2">Plan</th>
            <th className="py-1 pr-2">Landlord paid</th>
            {Array.from({ length: 7 }, (_, i) => <th key={i} className="px-1 py-1 text-center">Day {i + 1}</th>)}
            <th className="py-1 pl-2 text-right">7-day paid</th>
            <th className="py-1 pl-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.rent_request_id} className="border-t border-border/40">
              <td className="py-1.5 pr-2"><RowIdentity r={r} /></td>
              <td className="py-1.5 pr-2">{r.agent_name ?? '—'}</td>
              <td className="py-1.5 pr-2 whitespace-nowrap">{planLabel(r)}</td>
              <td className="py-1.5 pr-2 whitespace-nowrap">{fmtDay(r.landlord_paid_on)}</td>
              {Array.from({ length: 7 }, (_, i) => {
                const kind = cellKind(r, i);
                return (
                  <td key={i} className="px-0.5 py-1">
                    <div
                      title={cellTitle(r, i, kind)}
                      className={cn(
                        'min-w-[68px] whitespace-nowrap rounded px-1 py-1 text-center font-mono text-[10px]',
                        CELL_TONE[kind],
                        isDueDay(r, i) && 'ring-2 ring-primary',
                      )}
                    >
                      {cellText(r, i, kind)}
                    </div>
                  </td>
                );
              })}
              <td className="py-1.5 pl-2 text-right font-mono">
                {formatUGX(r.paid_7d)}
                <p className="text-muted-foreground">of {formatUGX(r.expected_to_date)} due</p>
              </td>
              <td className="py-1.5 pl-2"><StatusBadge status={r.row_status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[10px] text-muted-foreground">
        Green: paid in full · Amber: part paid · Red: missed · Grey: day not reached · Dashed: not due (weekly plans pay once a week; the ringed day is the due day). Amounts in UGX.
      </p>
    </div>
  );
}

function DotStrip({ r }: { r: First7Row }) {
  const kinds = Array.from({ length: 7 }, (_, i) => cellKind(r, i));
  return (
    <div className="flex items-center gap-1.5" role="img" aria-label={kinds.map((k, i) => `Day ${i + 1} ${DAY_STATE_LABEL[k].toLowerCase()}`).join(', ')}>
      {kinds.map((k, i) => (
        <span
          key={i}
          title={cellTitle(r, i, k)}
          className={cn('h-3.5 w-3.5 shrink-0 rounded-full', DOT_TONE[k], isDueDay(r, i) && 'ring-2 ring-primary ring-offset-1 ring-offset-card')}
        />
      ))}
    </div>
  );
}

function GridCards({ rows }: { rows: First7Row[] }) {
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.rent_request_id} className="space-y-2 rounded-xl border border-border bg-card p-3 text-xs">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0"><RowIdentity r={r} /></div>
            <StatusBadge status={r.row_status} />
          </div>
          <DotStrip r={r} />
          <div className="flex items-end justify-between gap-2">
            <div className="min-w-0 text-muted-foreground">
              <p className="truncate">{r.agent_name ?? '—'}</p>
              <p className="truncate">{planLabel(r)} · paid out {fmtDay(r.landlord_paid_on)}</p>
            </div>
            <p className="shrink-0 text-right font-mono font-semibold text-foreground">
              {formatUGX(r.paid_7d)}
              <span className="block text-[10px] font-normal text-muted-foreground">of {formatUGX(r.expected_to_date)} due</span>
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------- loading ----------

function LoadingState() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading First 7 Days">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => <SkeletonMetricCard key={i} className="p-3" />)}
      </div>
      <Skeleton className="h-14 w-full" />
      <SkeletonChart />
      <SkeletonTable rows={6} />
    </div>
  );
}

// ---------- the tab ----------

/** Agent Ops "First 7 Days": how new Rent Plans repay in their first seven days. Every figure and status comes from the server. */
export function First7DaysTab() {
  const [sp, setSp] = useSearchParams();
  const isMobile = useIsMobile();
  const today = kampalaToday();
  const params = useMemo(() => readFirst7Params(sp, today), [sp, today]);
  const preset = presetOf(params.from, params.to, today);
  const [customOpen, setCustomOpen] = useState(preset === 'custom');
  const [shown, setShown] = useState(PAGE);

  const update = (patch: Partial<First7Params>) => {
    setShown(PAGE);
    setSp((prev) => writeFirst7Params(prev, { ...readFirst7Params(prev, today), ...patch }, today), { replace: true });
  };

  const { rows, summary, isLoading, isFetching, error, refetch } = useNewTenantFirst7({ from: params.from, to: params.to, freq: params.freq });

  const visible = useMemo(() => sortFirst7Rows(filterFirst7Rows(rows, params)), [rows, params]);
  const filtered = params.q.trim() !== '' || params.card !== 'all' || params.day !== null;
  const clearFilters = () => update({ q: '', card: 'all', day: null });

  const showCustom = customOpen || preset === 'custom';
  const rangeLabel = params.from === params.to ? fmtDay(params.from) : `${fmtDay(params.from)} – ${fmtDay(params.to)}`;

  return (
    <div className="space-y-3 min-w-0">
      <Card className="space-y-3 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sprout className="h-4 w-4 text-primary" />
            <div>
              <p className="text-sm font-bold text-foreground">First 7 Days</p>
              <p className="text-[11px] text-muted-foreground">New Rent Plans by the day the landlord was paid. Day 1 is the day after.</p>
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={refetch} disabled={isFetching}>
            {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Landlord paid on">
            {PRESETS.map((p) => (
              <Button
                key={p.id}
                type="button"
                size="sm"
                variant={!showCustom && preset === p.id ? 'default' : 'outline'}
                aria-pressed={!showCustom && preset === p.id}
                className="h-8 text-xs"
                onClick={() => { setCustomOpen(false); update(presetRange(p.id, today)); }}
              >
                {p.label}
              </Button>
            ))}
            <Button type="button" size="sm" variant={showCustom ? 'default' : 'outline'} aria-pressed={showCustom} className="h-8 text-xs" onClick={() => setCustomOpen(true)}>
              Custom
            </Button>
          </div>
          <div className="flex items-center gap-1" role="group" aria-label="Payment frequency">
            {(['all', 'daily', 'weekly'] as FrequencyFilter[]).map((f) => (
              <Button
                key={f}
                type="button"
                size="sm"
                variant={params.freq === f ? 'default' : 'outline'}
                aria-pressed={params.freq === f}
                className="h-8 text-xs"
                onClick={() => update({ freq: f })}
              >
                {FREQ_LABEL[f]}
              </Button>
            ))}
          </div>
          <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={params.q}
              onChange={(e) => update({ q: e.target.value })}
              placeholder="Search agent or tenant"
              aria-label="Search agent or tenant"
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>

        {showCustom && (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <label className="flex items-center gap-1.5">
              From
              <Input type="date" value={params.from} max={today} onChange={(e) => e.target.value && update(clampRange(e.target.value, params.to, today, 'from'))} className="h-8 w-auto text-xs" />
            </label>
            <label className="flex items-center gap-1.5">
              To
              <Input type="date" value={params.to} max={today} onChange={(e) => e.target.value && update(clampRange(params.from, e.target.value, today, 'to'))} className="h-8 w-auto text-xs" />
            </label>
            <span>Up to 31 days.</span>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">Landlord paid {rangeLabel} · Kampala time</p>
      </Card>

      {isLoading ? (
        <LoadingState />
      ) : error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not load First 7 Days</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{first7ErrorMessage(error)}</p>
            <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={refetch}>
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {summary && <SummaryCards summary={summary} active={params.card} onPick={(card) => update({ card })} />}
          {summary && summary.plans > 0 && <CollectedStrip summary={summary} />}
          {summary && summary.plans > 0 && <DayChart summary={summary} day={params.day} onPick={(day) => update({ day })} />}

          {rows.length === 0 ? (
            <Card className="flex flex-col items-center gap-2 p-8 text-center">
              <Sprout className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-semibold text-foreground">No new Rent Plans in this range</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                No landlord was paid for a new Rent Plan {params.from === params.to ? 'on' : 'between'} {rangeLabel}{params.freq !== 'all' ? ` on a ${params.freq} schedule` : ''}. Try another date range.
              </p>
            </Card>
          ) : (
            <Card className="space-y-2 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  Showing <span className="font-semibold text-foreground">{visible.length}</span> of {rows.length} plans · behind and not started first
                </p>
                {filtered && (
                  <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={clearFilters}>
                    <X className="h-3.5 w-3.5" /> Clear filters
                  </Button>
                )}
              </div>
              {visible.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">No plans match these filters.</p>
              ) : (
                <>
                  {isMobile ? <GridCards rows={visible.slice(0, shown)} /> : <GridTable rows={visible.slice(0, shown)} />}
                  {visible.length > shown && (
                    <div className="flex justify-center pt-1">
                      <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => setShown((n) => n + PAGE)}>
                        Show {Math.min(PAGE, visible.length - shown)} more
                      </Button>
                    </div>
                  )}
                </>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
