import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
  computeSnapshots,
  getDepartments,
  getEmployees,
  getMetricDefinitions,
  getSnapshots,
  getTasks,
} from '@/hr/api';

import type {
  Department,
  Employee,
  MetricDefinition,
  MetricSnapshot,
  Task,
} from '@/hr/types';


type PeriodChoice = 'this_month' | 'last_month' | 'last_3_months';

const PERIOD_OPTIONS: { value: PeriodChoice; label: string }[] = [
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'last_3_months', label: 'Last 3 months' },
];

const SERIES_COLOURS = [
  'hsl(var(--primary))',
  '#10b981',
  '#f59e0b',
  '#6366f1',
  '#ec4899',
  '#14b8a6',
  '#f97316',
  '#8b5cf6',
];

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function iso(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function periodBounds(choice: PeriodChoice): { start: string; end: string } {
  const now = new Date();
  if (choice === 'last_month') {
    return {
      start: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      end: iso(new Date(now.getFullYear(), now.getMonth(), 0)),
    };
  }
  if (choice === 'last_3_months') {
    return {
      start: iso(new Date(now.getFullYear(), now.getMonth() - 2, 1)),
      end: iso(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
    };
  }
  return {
    start: iso(new Date(now.getFullYear(), now.getMonth(), 1)),
    end: iso(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
  };
}

function humanize(value: string) {
  return (value || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function formatValue(value: number | null, unit: string) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
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

/**
 * Same traffic light rule My Work uses: the metric's own direction plus its
 * amber_at / red_at. No target -> no judgement.
 */
function cellClass(
  value: number | null,
  def: MetricDefinition,
): string {
  if (value === null || def.target_value === null || def.target_value === undefined) {
    return 'text-muted-foreground';
  }
  const red = def.red_at ?? null;
  const amber = def.amber_at ?? null;
  const higherBetter = String(def.direction).startsWith('higher');

  if (higherBetter) {
    if (red !== null && value < red) return 'bg-destructive/10 text-destructive font-semibold';
    if (amber !== null && value < amber)
      return 'bg-amber-500/10 text-amber-600 dark:text-amber-400 font-semibold';
    return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-semibold';
  }
  if (red !== null && value > red) return 'bg-destructive/10 text-destructive font-semibold';
  if (amber !== null && value > amber)
    return 'bg-amber-500/10 text-amber-600 dark:text-amber-400 font-semibold';
  return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-semibold';
}

function withinPeriod(iso8601: string | null, start: string, end: string) {
  if (!iso8601) return false;
  const d = new Date(iso8601);
  if (Number.isNaN(d.getTime())) return false;
  const day = iso(d);
  return day >= start && day <= end;
}

export default function DepartmentProductivity() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [departmentId, setDepartmentId] = useState<string>('');
  const [period, setPeriod] = useState<PeriodChoice>('this_month');

  const [loading, setLoading] = useState(true);
  const [people, setPeople] = useState<Employee[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [definitions, setDefinitions] = useState<MetricDefinition[]>([]);
  const [snapshots, setSnapshots] = useState<MetricSnapshot[]>([]);
  

  const [recomputing, setRecomputing] = useState(false);
  const [lastRun, setLastRun] = useState<{ rows: number; at: Date } | null>(null);

  const bounds = useMemo(() => periodBounds(period), [period]);

  useEffect(() => {
    (async () => {
      try {
        const depts = await getDepartments();
        setDepartments(depts);
        setDepartmentId((current) => current || depts[0]?.id || '');
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not load departments');
      }
    })();
  }, []);

  const load = useCallback(async () => {
    if (!departmentId) return;
    setLoading(true);
    try {
      const [staff, deptTasks, defs, snaps] = await Promise.all([
        getEmployees(),
        getTasks({ departmentId }),
        getMetricDefinitions(departmentId),
        getSnapshots({ departmentId, periodStart: bounds.start, periodEnd: bounds.end }),
      ]);

      setPeople(staff.filter((p) => p.current_assignment?.department_id === departmentId));
      setTasks(deptTasks);
      setDefinitions(defs);
      setSnapshots(snaps);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load the department view');
    } finally {
      setLoading(false);
    }
  }, [departmentId, bounds.start, bounds.end]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Alphabetical only. No ranking of people anywhere on this page. */
  const roster = useMemo(
    () =>
      [...people].sort((a, b) =>
        (a.full_name || '').localeCompare(b.full_name || '', 'en', { sensitivity: 'base' }),
      ),
    [people],
  );

  const completedBars = useMemo(
    () =>
      roster.map((p) => {
        const personTasks = tasks.filter(
          (t) =>
            t.assignee_employee_id === p.id &&
            t.status === 'completed' &&
            withinPeriod(t.completed_at, bounds.start, bounds.end),
        );
        const dueTasks = personTasks.filter(
          (t) => t.due_at !== null && t.due_at !== undefined,
        );
        const onTimeTasks = dueTasks.filter(
          (t) =>
            new Date(t.completed_at as string).getTime() <=
            new Date(t.due_at as string).getTime(),
        );
        return {
          name: p.full_name || p.staff_number,
          completed: personTasks.length,
          due: dueTasks.length,
          onTime: onTimeTasks.length,
        };
      }),
    [roster, tasks, bounds.start, bounds.end],
  );

  const statusMix = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
    return Object.entries(counts).map(([status, value], i) => ({
      name: humanize(status),
      value,
      fill: SERIES_COLOURS[i % SERIES_COLOURS.length],
    }));
  }, [tasks]);

  /** Latest snapshot in the window, per person per definition. */
  const valueFor = useCallback(
    (staffId: string, definitionId: string): number | null => {
      const matches = snapshots.filter(
        (s) => s.subject_id === staffId && s.metric_definition_id === definitionId,
      );
      if (matches.length === 0) return null;
      const latest = matches.reduce((a, b) => (a.period_start >= b.period_start ? a : b));
      return latest.value === null || latest.value === undefined ? null : latest.value;
    },
    [snapshots],
  );

  const recompute = async () => {
    setRecomputing(true);
    try {
      const rows = await computeSnapshots(bounds.start, bounds.end);
      setLastRun({ rows, at: new Date() });
      toast.success(`Recomputed ${rows} row${rows === 1 ? '' : 's'}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Recompute failed');
    } finally {
      setRecomputing(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={departmentId} onValueChange={setDepartmentId}>
          <SelectTrigger className="h-9 w-56">
            <SelectValue placeholder="Select department" />
          </SelectTrigger>
          <SelectContent>
            {departments.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={period} onValueChange={(v) => setPeriod(v as PeriodChoice)}>
          <SelectTrigger className="h-9 w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIOD_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button size="sm" variant="outline" disabled={recomputing} onClick={recompute}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${recomputing ? 'animate-spin' : ''}`} />
          Recompute
        </Button>

        {lastRun && (
          <span className="text-xs text-muted-foreground">
            {lastRun.rows} row{lastRun.rows === 1 ? '' : 's'} · ran{' '}
            {lastRun.at.toLocaleTimeString('en-GB')}
          </span>
        )}

        <span className="ml-auto text-xs text-muted-foreground">
          {bounds.start} → {bounds.end}
        </span>
      </div>

      {loading ? (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Tasks completed, deadlines met</CardTitle>
              </CardHeader>
              <CardContent className="h-64">
                {completedBars.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nobody is posted here yet</p>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={completedBars} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                      <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-20} height={50} textAnchor="end" />
                      <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                      <Tooltip />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="completed" name="Completed" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="due" name="Had a deadline" fill={SERIES_COLOURS[1]} radius={[4, 4, 0, 0]} />
                      <Bar dataKey="onTime" name="Met the deadline" fill={SERIES_COLOURS[2]} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Current task status mix</CardTitle>
              </CardHeader>
              <CardContent className="h-64">
                {statusMix.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No tasks in this department</p>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={statusMix}
                        dataKey="value"
                        nameKey="name"
                        innerRadius={50}
                        outerRadius={80}
                        paddingAngle={2}
                      >
                        {statusMix.map((s) => (
                          <Cell key={s.name} fill={s.fill} />
                        ))}
                      </Pie>
                      <Tooltip />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Metrics by person</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {roster.length === 0 || definitions.length === 0 ? (
                <p className="p-4 text-center text-sm text-muted-foreground">
                  {definitions.length === 0
                    ? 'No metrics are configured for this department yet'
                    : 'Nobody is posted here yet'}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Person</TableHead>
                        {definitions.map((def) => (
                          <TableHead key={def.id} className="whitespace-nowrap">
                            {def.name}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {roster.map((p) => (
                        <TableRow key={p.id}>
                          <TableCell className="whitespace-nowrap">
                            <Link
                              to={`/hr/dashboard/scorecard/${p.id}`}
                              className="text-sm font-medium text-foreground hover:underline"
                            >
                              {p.full_name || p.staff_number}
                            </Link>
                          </TableCell>
                          {definitions.map((def) => {
                            const value = valueFor(p.id, def.id);
                            return (
                              <TableCell
                                key={def.id}
                                className={`text-sm ${cellClass(value, def)}`}
                              >
                                {formatValue(value, def.unit)}
                              </TableCell>
                            );
                          })}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
