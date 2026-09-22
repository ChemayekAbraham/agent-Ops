import { useMemo, useState } from 'react';
import { useTheme } from 'next-themes';
import {
  CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  CheckCircle2, PhoneCall, PhoneIncoming, PhoneOff, Repeat2, Snowflake, Timer, XCircle,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import {
  buildMostCalled, buildOutcomeTrend, buildRoleShare, computeSectionKpis, formatCallStamp,
  formatTalkTime,
  OUTCOME_LABEL, type CallOutcome, type CallRecord, type CallSection,
} from '@/lib/callCentre';
import { useCallSectionCounts, useSectionCallRecords } from '@/hooks/useCrmCallCentre';
import { useRestoreBodyPointerEvents } from '@/hooks/useRestoreBodyPointerEvents';
import { resolveChartTheme } from './callCentreChartTheme';
import { CallDrawer } from './CallDrawer';
import { useCallDialer, type DialTarget } from './useCallDialer';

const RANGES = [
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
  { value: '30', label: '30 days' },
] as const;

const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '??';

const OUTCOME_TONE: Record<CallOutcome, string> = {
  answered: 'border-success/40 text-success',
  rejected: 'border-destructive/40 text-destructive',
  not_reachable: 'border-warning/40 text-warning',
  in_progress: 'border-primary/40 text-primary',
};

/* ------------------------------------------------------------------ *
 * KPI tile
 * ------------------------------------------------------------------ */

function Kpi({
  label, value, hint, icon: Icon, tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: 'neutral' | 'good' | 'bad' | 'warn';
}) {
  // Status colour always ships beside an icon and a word, never alone.
  const tones = {
    neutral: 'text-foreground',
    good: 'text-success',
    bad: 'text-destructive',
    warn: 'text-warning',
  } as const;

  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
        </div>
        <div className={cn('mt-1 text-xl font-bold tabular-nums', tones[tone])}>{value}</div>
        {hint && <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Tooltips — text wears text tokens, the swatch carries identity
 * ------------------------------------------------------------------ */

interface TooltipPayloadEntry {
  name?: string;
  value?: number | string;
  color?: string;
  payload?: Record<string, unknown>;
}

function TrendTooltip({
  active, payload, label, bg, border, text,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
  bg: string;
  border: string;
  text: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-lg px-2.5 py-2 text-xs shadow-md"
      style={{ background: bg, border: `1px solid ${border}`, color: text }}
    >
      <div className="mb-1 font-semibold">{label}</div>
      {payload.map((entry) => (
        <div key={entry.name} className="flex items-center gap-1.5">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: entry.color }}
            aria-hidden
          />
          <span className="opacity-80">{entry.name}</span>
          <span className="ml-auto pl-3 font-semibold tabular-nums">{entry.value}</span>
        </div>
      ))}
    </div>
  );
}

/** End-of-line direct label. Rendered only at the final point, per the
 *  "label selectively — never a number on every point" rule. */
function endLabel(lastIndex: number, colour: string) {
  return function EndLabel(props: { x?: number; y?: number; value?: number; index?: number }) {
    const { x, y, value, index } = props;
    if (index !== lastIndex || x === undefined || y === undefined) return null;
    return (
      <text x={x} y={y - 10} textAnchor="end" fontSize={11} fontWeight={700} fill={colour}>
        {value}
      </text>
    );
  };
}

/* ------------------------------------------------------------------ *
 * Overview
 * ------------------------------------------------------------------ */

interface CallCentreOverviewProps {
  /** Which queue this panel describes. One of the five `CallSection` values. */
  section: CallSection;
}

export function CallCentreOverview({ section }: CallCentreOverviewProps) {
  // The dialer sheet can leave <body> pointer-events:none behind on close.
  useRestoreBodyPointerEvents();
  const { resolvedTheme } = useTheme();
  const theme = resolveChartTheme(resolvedTheme === 'dark');

  // Queue membership is resolved server-side: filtering the flat feed on
  // `record.calleeRole` here would miss anyone whose role changed after the
  // call was placed, because that column is a snapshot.
  const { records, isLoading, error } = useSectionCallRecords(section);
  const { counts } = useCallSectionCounts();
  const queueSize = counts[section] ?? 0;
  const { target, dial, close } = useCallDialer();

  const [range, setRange] = useState<(typeof RANGES)[number]['value']>('14');
  const days = Number(range);

  /** Calls inside the selected window — every KPI and chart reads this, so the
   *  range control cannot leave one figure describing a different period. */
  const scoped = useMemo<CallRecord[]>(() => {
    if (records.length === 0) return [];
    const newest = Math.max(...records.map((r) => new Date(r.calledAt).getTime()));
    const cutoff = newest - (days - 1) * 86_400_000;
    const startOfCutoffDay = new Date(cutoff);
    startOfCutoffDay.setHours(0, 0, 0, 0);
    return records.filter((r) => new Date(r.calledAt).getTime() >= startOfCutoffDay.getTime());
  }, [records, days]);

  // `computeSectionKpis` adds the two tiles that count PEOPLE rather than
  // calls — Total Numbers (the queue) and how many of them have been reached.
  const kpis = useMemo(() => computeSectionKpis(scoped, queueSize), [scoped, queueSize]);
  const trend = useMemo(() => buildOutcomeTrend(records, { days }), [records, days]);
  const roleShare = useMemo(() => buildRoleShare(scoped), [scoped]);

  /** "Most called that day" — the newest day that actually has calls, so the
   *  panel is never blank just because nobody has been rung yet today. */
  const busiestDay = useMemo(() => {
    if (records.length === 0) return null;
    return records.reduce<string>((acc, r) => (r.calledAt > acc ? r.calledAt : acc), records[0].calledAt);
  }, [records]);

  const mostCalled = useMemo(
    () => (busiestDay ? buildMostCalled(records, { onDate: new Date(busiestDay), limit: 8 }) : []),
    [records, busiestDay],
  );

  const totalPeople = roleShare.reduce((a, s) => a + s.people, 0);
  const lastIndex = trend.length - 1;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="h-[74px] rounded-xl" />)}
        </div>
        <Skeleton className="h-72 rounded-xl" />
        <div className="grid gap-3 lg:grid-cols-5">
          <Skeleton className="h-80 rounded-xl lg:col-span-3" />
          <Skeleton className="h-80 rounded-xl lg:col-span-2" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-destructive">
          Could not load call activity. Refresh to try again.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filters sit in one row above the charts. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-foreground">Call Center overview</h2>
          <p className="text-xs text-muted-foreground">
            {kpis.totalCalls} call{kpis.totalCalls === 1 ? '' : 's'} in the last {days} days
          </p>
        </div>
        <ToggleGroup
          type="single"
          value={range}
          onValueChange={(v) => v && setRange(v as typeof range)}
          aria-label="Date range"
        >
          {RANGES.map((r) => (
            <ToggleGroupItem key={r.value} value={r.value} size="sm" className="px-3 text-xs">
              {r.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {/* ---------- KPIs ---------- */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        <Kpi label="Total calls" value={String(kpis.totalCalls)} icon={PhoneCall} />
        <Kpi
          label="Cold calls"
          value={String(kpis.coldCalls)}
          hint="First real contact"
          icon={Snowflake}
        />
        <Kpi
          label="Warm calls"
          value={String(kpis.warmCalls)}
          hint="Spoken to before"
          icon={Repeat2}
        />
        <Kpi
          label="Accepted"
          value={String(kpis.answered)}
          hint={kpis.answerRate === null ? undefined : `${Math.round(kpis.answerRate)}% answer rate`}
          icon={CheckCircle2}
          tone="good"
        />
        <Kpi label="Rejected" value={String(kpis.rejected)} icon={XCircle} tone="bad" />
        <Kpi
          label="Bounced"
          value={String(kpis.notReachable)}
          hint="Not reachable"
          icon={PhoneOff}
          tone="warn"
        />
        <Kpi
          label="Avg call time"
          value={formatTalkTime(kpis.averageTalkSeconds)}
          hint="Answered calls only"
          icon={Timer}
        />
      </div>

      {/* ---------- Accepted vs rejected trend ---------- */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Accepted vs rejected calls</CardTitle>
          <p className="text-xs text-muted-foreground">Daily counts over the last {days} days.</p>
        </CardHeader>
        <CardContent className="pt-0">
          {trend.every((p) => p.answered === 0 && p.rejected === 0) ? (
            <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              No settled calls in this window yet.
            </p>
          ) : (
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend} margin={{ top: 16, right: 16, bottom: 4, left: -12 }}>
                  <CartesianGrid stroke={theme.grid} strokeWidth={1} vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10, fill: theme.axis }}
                    stroke={theme.grid}
                    interval="preserveStartEnd"
                    minTickGap={16}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: theme.axis }}
                    stroke={theme.grid}
                    width={40}
                    allowDecimals={false}
                  />
                  <Tooltip
                    cursor={{ stroke: theme.axis, strokeWidth: 1 }}
                    content={
                      <TrendTooltip bg={theme.tooltipBg} border={theme.tooltipBorder} text={theme.tooltipText} />
                    }
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} iconType="plainline" iconSize={14} />
                  <Line
                    type="monotone"
                    name="Accepted"
                    dataKey="answered"
                    stroke={theme.answered}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    dot={{ r: 4, fill: theme.answered, stroke: theme.surface, strokeWidth: 2 }}
                    activeDot={{ r: 6, fill: theme.answered, stroke: theme.surface, strokeWidth: 2 }}
                    label={endLabel(lastIndex, theme.answered)}
                  />
                  <Line
                    type="monotone"
                    name="Rejected"
                    dataKey="rejected"
                    stroke={theme.rejected}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    dot={{ r: 4, fill: theme.rejected, stroke: theme.surface, strokeWidth: 2 }}
                    activeDot={{ r: 6, fill: theme.rejected, stroke: theme.surface, strokeWidth: 2 }}
                    label={endLabel(lastIndex, theme.rejected)}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------- 60% recall list | 40% audience doughnut ---------- */}
      <div className="grid gap-3 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <PhoneIncoming className="h-4 w-4 text-primary" aria-hidden />
              Most called {busiestDay ? formatCallStamp(busiestDay).split(',')[0] : 'today'}
            </CardTitle>
            <p className="text-xs text-muted-foreground">Busiest numbers that day — recall straight from here.</p>
          </CardHeader>
          <CardContent className="pt-0">
            {mostCalled.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                No calls placed that day.
              </p>
            ) : (
              <ul className="divide-y divide-border/60">
                {mostCalled.map((person) => (
                  <li key={person.calleeId} className="flex items-center gap-2.5 py-2.5">
                    <Avatar className="h-9 w-9 shrink-0">
                      <AvatarImage src={person.avatarUrl ?? undefined} alt="" />
                      <AvatarFallback className="bg-primary/10 text-[11px] text-primary">
                        {initials(person.name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-foreground">{person.name}</div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {person.calls} call{person.calls === 1 ? '' : 's'} · {person.answered} answered
                        {person.location ? ` · ${person.location}` : ''}
                      </div>
                    </div>
                    <Badge
                      variant="outline"
                      className={cn('shrink-0 text-[10px]', OUTCOME_TONE[person.lastOutcome])}
                    >
                      {OUTCOME_LABEL[person.lastOutcome]}
                    </Badge>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="shrink-0 gap-1.5"
                      onClick={() =>
                        dial({
                          calleeId: person.calleeId,
                          name: person.name,
                          phone: person.phone,
                          avatarUrl: person.avatarUrl,
                          role: person.role,
                          location: person.location,
                        } satisfies DialTarget)
                      }
                    >
                      <PhoneCall className="h-3.5 w-3.5" />
                      Recall
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Who we called</CardTitle>
            <p className="text-xs text-muted-foreground">
              Share of the {totalPeople} {totalPeople === 1 ? 'person' : 'people'} reached out to.
            </p>
          </CardHeader>
          <CardContent className="pt-0">
            {roleShare.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                Nobody called in this window.
              </p>
            ) : (
              <>
                <div className="relative h-48 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={roleShare}
                        dataKey="people"
                        nameKey="label"
                        innerRadius="58%"
                        outerRadius="88%"
                        paddingAngle={0}
                        /* 2px gap in the surface colour separates touching
                           slices — the gap does the separating, not a border. */
                        stroke={theme.surface}
                        strokeWidth={2}
                        isAnimationActive={false}
                      >
                        {roleShare.map((slice, i) => (
                          <Cell
                            key={slice.role}
                            fill={theme.roleSlices[i % theme.roleSlices.length]}
                          />
                        ))}
                      </Pie>
                      <Tooltip
                        content={
                          <TrendTooltip bg={theme.tooltipBg} border={theme.tooltipBorder} text={theme.tooltipText} />
                        }
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  {/* Hero figure in the hole — the total the slices divide up. */}
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-2xl font-bold tabular-nums text-foreground">{totalPeople}</span>
                    <span className="text-[10px] text-muted-foreground">people</span>
                  </div>
                </div>

                {/* Numeric legend: the relief for the light-mode contrast warning,
                    and the way close slices are actually compared. */}
                <ul className="mt-3 space-y-1.5">
                  {roleShare.map((slice, i) => (
                    <li key={slice.role} className="flex items-center gap-2 text-xs">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-sm"
                        style={{ background: theme.roleSlices[i % theme.roleSlices.length] }}
                        aria-hidden
                      />
                      <span className="truncate text-muted-foreground">{slice.label}</span>
                      <span className="ml-auto shrink-0 font-semibold tabular-nums text-foreground">
                        {Math.round(slice.percent)}%
                      </span>
                      <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                        {slice.people} · {slice.calls}c
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  Distinct people, then total calls — one person rung five times counts once.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <CallDrawer target={target} open={!!target} onOpenChange={(o) => !o && close()} />
    </div>
  );
}
