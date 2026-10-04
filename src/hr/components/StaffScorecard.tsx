import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from 'sonner';
import {
  getActiveAssignmentsByStaff,
  getEmployee,
  getMetricDefinitions,
  getSnapshots,
  getTasks,
} from '@/hr/api';
import { supabase } from '@/hr/api/client';
import type {
  ActiveAssignment,
} from '@/hr/api/people';
import type { Employee, MetricDefinition, MetricSnapshot, Task } from '@/hr/types';

/** How many periods the trend line covers. */
const TREND_PERIODS = 6;

const DASH = '—';


interface Period {
  start: string;
  end: string;
  label: string;
}

function iso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The last `count` calendar months, newest first. */
function recentPeriods(count: number, now = new Date()): Period[] {
  const out: Period[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
    out.push({
      start: iso(start),
      end: iso(end),
      label: start.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }),
    });
  }
  return out;
}

function humanize(value: string) {
  return (value || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function formatValue(value: number | null, unit: string) {
  if (value === null || value === undefined || Number.isNaN(value)) return DASH;
  const rounded = Math.round(value * 100) / 100;
  switch (unit) {
    case 'percent':
      return `${rounded}%`;
    case 'currency_ugx':
      return `UGX ${rounded.toLocaleString('en-UG')}`;
    case 'hours':
      return `${rounded} h`;
    case 'days':
      return `${rounded} d`;
    default:
      return `${rounded}`;
  }
}

function formatStamp(isoString: string | null) {
  if (!isoString) return DASH;
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Traffic light from the metric's own direction and thresholds — the same rule
 * My Work uses. No target, or no value, means grey and no judgement.
 */
function toneFor(
  value: number | null,
  def: MetricDefinition,
): 'none' | 'good' | 'amber' | 'bad' {
  if (value === null || def.target_value === null || def.target_value === undefined) return 'none';
  const red = def.red_at ?? null;
  const amber = def.amber_at ?? null;
  const higherBetter = String(def.direction).startsWith('higher');

  if (higherBetter) {
    if (red !== null && value < red) return 'bad';
    if (amber !== null && value < amber) return 'amber';
    return 'good';
  }
  if (red !== null && value > red) return 'bad';
  if (amber !== null && value > amber) return 'amber';
  return 'good';
}

const DOT_CLASS: Record<string, string> = {
  none: 'bg-muted-foreground/40',
  good: 'bg-emerald-500',
  amber: 'bg-amber-500',
  bad: 'bg-destructive',
};

const VALUE_CLASS: Record<string, string> = {
  none: 'text-muted-foreground',
  good: 'text-emerald-600 dark:text-emerald-400',
  amber: 'text-amber-600 dark:text-amber-400',
  bad: 'text-destructive',
};

/**
 * Attainment as a percentage of target so six metrics in six different units
 * can share one radar. Direction aware: for lower-is-better metrics the ratio
 * is inverted, so 100 always means "on target" and more is always better.
 * Returns null when there is nothing to compare — the radar then plots 0 for
 * that spoke and the tile shows a dash, never an invented number.
 */
function attainment(value: number | null, def: MetricDefinition): number | null {
  const target = def.target_value;
  if (value === null || target === null || target === undefined) return null;
  const higherBetter = String(def.direction).startsWith('higher');
  if (higherBetter) {
    if (target === 0) return null;
    return Math.round((value / target) * 100);
  }
  if (value === 0) return 200; // nothing bad happened at all — capped below
  return Math.round((target / value) * 100);
}

interface Props {
  staffId: string;
}

/**
 * Individual scorecard — /hr/dashboard/scorecard/:staffId
 *
 * Every number is read straight from hr_metric_definitions, hr_metric_snapshots
 * and hr_tasks. Row-level security decides what the viewer may read; when the
 * database returns nothing this renders an unavailable state rather than
 * guessing.
 */
export default function StaffScorecard({ staffId }: Props) {
  const periods = useMemo(() => recentPeriods(TREND_PERIODS), []);
  const [periodStart, setPeriodStart] = useState<string>(periods[0]?.start ?? '');
  const [loading, setLoading] = useState(true);
  const [staff, setStaff] = useState<Employee | null>(null);
  const [assignment, setAssignment] = useState<ActiveAssignment | null>(null);
  const [definitions, setDefinitions] = useState<MetricDefinition[]>([]);
  const [snapshots, setSnapshots] = useState<MetricSnapshot[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [trendMetricId, setTrendMetricId] = useState<string>('');
  const [accountId, setAccountId] = useState<string | null>(null);

  const period = periods.find((p) => p.start === periodStart) ?? periods[0];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const person = await getEmployee(staffId);
      setStaff(person);
      if (!person) {
        setAccountId(null);
        setAssignment(null);
        setDefinitions([]);
        setSnapshots([]);
        setTasks([]);
        return;
      }

      const oldest = periods[periods.length - 1];
      // The enrolled account id comes from the hr_staff row itself, by id.
      const staffRow = await supabase
        .from('hr_staff')
        .select('user_id')
        .eq('id', staffId)
        .maybeSingle();
      setAccountId(((staffRow.data as { user_id?: string } | null)?.user_id) ?? null);

      const [assignmentsByStaff, defs, snaps, theirTasks] = await Promise.all([
        getActiveAssignmentsByStaff(),
        getMetricDefinitions(person.current_assignment?.department_id),
        // Every period in the trend window, in one read.
        getSnapshots({ staffId: person.id, periodStart: oldest.start, periodEnd: periods[0].end }),
        getTasks({ assigneeEmployeeId: person.id }),
      ]);

      const mine = assignmentsByStaff[person.id] ?? [];
      setAssignment(mine.find((a) => a.is_primary) ?? mine[0] ?? null);
      setDefinitions(defs);
      setSnapshots(snaps);
      setTasks(theirTasks);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load this scorecard');
    } finally {
      setLoading(false);
    }
  }, [staffId, periods]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Every active definition the database returns, in display order. */
  const scored = useMemo(() => {
    const active = definitions.filter((d) => d.active);
    return active.map((def) => {
      const snap = snapshots.find(
        (s) => s.metric_definition_id === def.id && s.period_start === period?.start,
      );
      const value = snap ? snap.value : null;
      return {
        def,
        snapshot: snap ?? null,
        value,
        tone: toneFor(value, def),
        attainment: attainment(value, def),
      };
    });
  }, [definitions, snapshots, period]);

  useEffect(() => {
    if (!trendMetricId && scored.length > 0) setTrendMetricId(scored[0].def.id);
  }, [scored, trendMetricId]);

  /** Only spokes with a real, comparable attainment. A missing value is never plotted as 0. */
  const radarData = useMemo(
    () =>
      scored
        .filter((row) => row.def.target_value !== null && row.attainment !== null)
        .map((row) => ({
          metric: row.def.name,
          Attainment: Math.min(row.attainment as number, 150),
          Target: 100,
        })),
    [scored],
  );

  /** Named beneath the chart so an omitted spoke is explained, never silently dropped. */
  const omittedFromRadar = useMemo(
    () =>
      scored
        .filter((row) => row.def.target_value === null || row.attainment === null)
        .map((row) => row.def.name),
    [scored],
  );

  const trendRows = useMemo(() => {
    const def = definitions.find((d) => d.id === trendMetricId);
    if (!def) return [];
    return [...periods]
      .reverse()
      .map((p) => {
        const snap = snapshots.find(
          (s) => s.metric_definition_id === def.id && s.period_start === p.start,
        );
        return { period: p.label, value: snap ? snap.value : null };
      });
  }, [definitions, snapshots, trendMetricId, periods]);

  const trendDef = definitions.find((d) => d.id === trendMetricId) ?? null;

  /** Tasks that touch the selected period, bucketed by status. */
  const tasksByStatus = useMemo(() => {
    if (!period) return [] as { status: string; items: Task[] }[];
    const from = new Date(`${period.start}T00:00:00`).getTime();
    const to = new Date(`${period.end}T23:59:59`).getTime();
    const inPeriod = tasks.filter((t) => {
      const stamps = [t.created_at, t.due_at, t.completed_at]
        .filter(Boolean)
        .map((s) => new Date(s as string).getTime())
        .filter((n) => !Number.isNaN(n));
      return stamps.some((n) => n >= from && n <= to);
    });
    const grouped: Record<string, Task[]> = {};
    for (const t of inPeriod) (grouped[t.status] ||= []).push(t);
    return Object.entries(grouped)
      .map(([status, items]) => ({ status, items }))
      .sort((a, b) => b.items.length - a.items.length);
  }, [tasks, period]);

  /** The stamp and rubric version the footer quotes — newest snapshot in the period. */
  const provenance = useMemo(() => {
    const inPeriod = scored.map((s) => s.snapshot).filter(Boolean) as MetricSnapshot[];
    if (inPeriod.length === 0) return { computedAt: null as string | null, version: null as number | null };
    const newest = inPeriod.reduce((a, b) =>
      new Date(b.computed_at).getTime() > new Date(a.computed_at).getTime() ? b : a,
    );
    return { computedAt: newest.computed_at, version: newest.metric_definition_version };
  }, [scored]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-80 w-full" />
          <Skeleton className="h-80 w-full" />
        </div>
      </div>
    );
  }

  if (!staff) {
    return (
      <Card>
        <CardContent className="py-16 text-center">
          <p className="text-sm font-medium text-foreground">This record is unavailable</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Either no such staff member exists, or you are not permitted to view them.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Identity — who this record is, and which account is paid */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Staff ref</p>
              <p className="font-mono text-sm font-medium">{staff.staff_number || DASH}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Full name</p>
              <p className="text-sm font-medium">{staff.full_name || DASH}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Phone</p>
              <p className="text-sm font-medium">
                {staff.phone || <span className="text-muted-foreground">{DASH}</span>}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Email</p>
              <p className="text-sm font-medium break-all">
                {staff.email || <span className="text-muted-foreground">{DASH}</span>}
              </p>
            </div>
            <div className="lg:col-span-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Account id</p>
              <p className="font-mono text-xs font-medium break-all">
                {accountId || <span className="text-muted-foreground">{DASH}</span>}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Department</p>
              <p className="text-sm font-medium">
                {assignment?.department_name || staff.current_assignment?.department_name || DASH}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Position</p>
              <p className="text-sm font-medium">
                {assignment?.position_title || staff.current_assignment?.role_title || DASH}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Assignment started
              </p>
              <p className="text-sm font-medium">{assignment?.started_on || DASH}</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            This staff record is linked to account {accountId || DASH}.
          </p>
        </CardContent>
      </Card>

      {/* Header */}
      <Card>
        <CardContent className="flex flex-wrap items-start gap-x-8 gap-y-3 p-4">
          <div className="min-w-0">
            <h3 className="text-lg font-bold leading-tight text-foreground">
              {staff.full_name || DASH}
            </h3>
            <p className="text-xs text-muted-foreground">
              {assignment?.position_title || staff.current_assignment?.role_title || DASH}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Department</p>
            <p className="text-sm font-medium">
              {assignment?.department_name || staff.current_assignment?.department_name || DASH}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Reports to</p>
            <p className="text-sm font-medium">{assignment?.reports_to_title || DASH}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Staff ref</p>
            <p className="text-sm font-medium">{staff.staff_number || DASH}</p>
          </div>
          <div className="ml-auto">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Period</p>
            <Select value={periodStart} onValueChange={setPeriodStart}>
              <SelectTrigger className="mt-1 h-8 w-40 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {periods.map((p) => (
                  <SelectItem key={p.start} value={p.start}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 1. Radar — value against target */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Metrics against target · {period?.label ?? DASH}
            </CardTitle>
          </CardHeader>
          <CardContent className={omittedFromRadar.length > 0 ? 'h-80 pb-0' : 'h-80'}>
            {radarData.length === 0 ? (
              <p className="pt-24 text-center text-xs text-muted-foreground">
                No metric here has both a target and a value for this period, so there is
                nothing that can be plotted against target.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={omittedFromRadar.length > 0 ? '82%' : '100%'}>
                <RadarChart data={radarData} outerRadius="72%">
                  <PolarGrid stroke="hsl(var(--border))" />
                  <PolarAngleAxis dataKey="metric" tick={{ fontSize: 10 }} />
                  <PolarRadiusAxis angle={90} domain={[0, 150]} tick={{ fontSize: 9 }} />
                  <Tooltip formatter={(v: number | string) => `${v}% of target`} />
                  <Radar
                    name="Target"
                    dataKey="Target"
                    stroke="hsl(var(--muted-foreground))"
                    fill="hsl(var(--muted-foreground))"
                    fillOpacity={0.08}
                  />
                  <Radar
                    name="Actual"
                    dataKey="Attainment"
                    stroke="hsl(var(--primary))"
                    fill="hsl(var(--primary))"
                    fillOpacity={0.3}
                  />
                </RadarChart>
              </ResponsiveContainer>
            )}
            {omittedFromRadar.length > 0 && (
              <p className="pt-1 text-[10px] leading-tight text-muted-foreground">
                Not plotted (no target or no value this period): {omittedFromRadar.join(', ')}.
                Shown as tiles instead — a missing measurement is never drawn as zero.
              </p>
            )}
          </CardContent>
        </Card>

        {/* 2. Every definition as a tile, including those the radar omits */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Metric detail</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2">
            {scored.length === 0 && (
              <p className="col-span-2 py-8 text-center text-xs text-muted-foreground">
                Nothing to show for this period.
              </p>
            )}
            {scored.map((row) => (
              <div key={row.def.id} className="rounded-lg border border-border p-3">
                <div className="flex items-center gap-1.5">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[row.tone]}`} />
                  <p className="truncate text-[11px] text-muted-foreground">{row.def.name}</p>
                </div>
                <p className={`mt-1 text-base font-bold ${VALUE_CLASS[row.tone]}`}>
                  {formatValue(row.value, row.def.unit)}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  Target {formatValue(row.def.target_value, row.def.unit)} · {row.def.unit.replace(/_/g, ' ')}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* 3. Trend over the last six periods */}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-2">
          <CardTitle className="text-sm">Trend · last {TREND_PERIODS} periods</CardTitle>
          <Select value={trendMetricId} onValueChange={setTrendMetricId}>
            <SelectTrigger className="h-8 w-56 text-xs">
              <SelectValue placeholder="Pick a metric" />
            </SelectTrigger>
            <SelectContent>
              {scored.map((row) => (
                <SelectItem key={row.def.id} value={row.def.id}>
                  {row.def.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent className="h-64">
          {trendRows.length === 0 ? (
            <p className="pt-20 text-center text-xs text-muted-foreground">
              Pick a metric to see its trend.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendRows}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="period" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" width={50} />
                <Tooltip
                  formatter={(v: number | string) =>
                    formatValue(v === null ? null : Number(v), trendDef?.unit ?? 'count')
                  }
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* 4. Tasks in the period, grouped by status */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Tasks in {period?.label ?? DASH}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {tasksByStatus.length === 0 && (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No tasks fall inside this period.
            </p>
          )}
          {tasksByStatus.map((group) => (
            <div key={group.status}>
              <p className="mb-1.5 text-xs font-semibold text-foreground">
                {humanize(group.status)}{' '}
                <span className="font-normal text-muted-foreground">({group.items.length})</span>
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-[11px]">Ref</TableHead>
                    <TableHead className="text-[11px]">Title</TableHead>
                    <TableHead className="text-[11px]">Priority</TableHead>
                    <TableHead className="text-[11px]">Due</TableHead>
                    <TableHead className="text-[11px]">Completed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.items.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="text-xs text-muted-foreground">{t.ref || DASH}</TableCell>
                      <TableCell className="text-xs">{t.title || DASH}</TableCell>
                      <TableCell className="text-xs">{humanize(t.priority ?? '') || DASH}</TableCell>
                      <TableCell className="text-xs">
                        {t.due_at ? new Date(t.due_at).toLocaleDateString('en-GB') : DASH}
                      </TableCell>
                      <TableCell className="text-xs">
                        {t.completed_at ? new Date(t.completed_at).toLocaleDateString('en-GB') : DASH}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* 5. Provenance */}
      <p className="text-[11px] text-muted-foreground">
        Computed from task events on {formatStamp(provenance.computedAt)} · Rubric version{' '}
        {provenance.version === null ? DASH : `v${provenance.version}`}
      </p>
    </div>
  );
}
