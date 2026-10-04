import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { RefreshCw, MessageSquarePlus, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
  addTaskEvent,
  getDepartments,
  getMetricDefinitions,
  getSnapshots,
  getStaffDirectory,
  getTasks,
} from '@/hr/api';
import { supabase } from '@/hr/api/client';
import { useQuery } from '@tanstack/react-query';
import { PartnerOpsPendingSummary } from '@/components/executive/PartnerOpsPendingSummary';
import { PartnerOpsScoreboard } from '@/components/executive/PartnerOpsScoreboard';
import type { Department, Employee, MetricDefinition, MetricSnapshot, Task } from '@/hr/types';
import TaskFormDialog from './TaskFormDialog';
import TasksList from './TasksList';

/** Month start (YYYY-MM-01) used by the partner ops RPCs. */
const partnerOpsMonthStart = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

/**
 * Partner Ops production block. Renders nothing at all when the scoreboard
 * RPC returns no rows for the current month.
 */
function PartnerOpsProductionSection() {
  const { data: rowCount } = useQuery({
    queryKey: ['executive-brief-partner-ops-rows', partnerOpsMonthStart()],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('partner_ops_scoreboard' as never, {
        p_month: partnerOpsMonthStart(),
      } as never);
      if (error) throw error;
      return Array.isArray(data) ? (data as unknown[]).length : 0;
    },
    staleTime: 120000,
  });

  if (!rowCount) return null;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Partner Ops production</h3>
      <PartnerOpsPendingSummary />
      <PartnerOpsScoreboard hideTargetEditor />
    </div>
  );
}

/** Statuses that take a task out of the open list. */
const CLOSED: string[] = ['completed', 'cancelled'];

const STATUS_PILL: Record<string, string> = {
  open: 'bg-muted text-foreground',
  assigned: 'bg-muted text-foreground',
  in_progress: 'bg-primary/15 text-primary',
  blocked: 'bg-destructive/15 text-destructive',
  submitted: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  returned: 'bg-destructive/15 text-destructive',
  completed: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  cancelled: 'bg-muted text-muted-foreground',
};

/** Chart colours, keyed by task status. Themed tokens only. */
const STATUS_FILL: Record<string, string> = {
  open: 'hsl(var(--muted-foreground))',
  assigned: 'hsl(var(--muted-foreground))',
  in_progress: 'hsl(var(--primary))',
  blocked: 'hsl(var(--destructive))',
  submitted: 'hsl(var(--chart-4, var(--primary)))',
  returned: 'hsl(var(--destructive))',
  completed: 'hsl(var(--chart-2, var(--primary)))',
  cancelled: 'hsl(var(--border))',
};

function fillFor(status: string) {
  return STATUS_FILL[status] ?? 'hsl(var(--muted-foreground))';
}


function humanize(value: string) {
  return (value || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function formatDate(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
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

/** Same direction-aware traffic light used on My Work. */
function dotClass(
  value: number | null,
  def: MetricDefinition,
): string {
  if (value === null || def.target_value === null || def.target_value === undefined) {
    return 'bg-muted-foreground/40';
  }
  const red = def.red_at ?? null;
  const amber = def.amber_at ?? null;
  const higherBetter = String(def.direction).startsWith('higher');

  if (higherBetter) {
    if (red !== null && value < red) return 'bg-destructive';
    if (amber !== null && value < amber) return 'bg-amber-500';
    return 'bg-emerald-500';
  }
  if (red !== null && value > red) return 'bg-destructive';
  if (amber !== null && value > amber) return 'bg-amber-500';
  return 'bg-emerald-500';
}

function monthBounds(now: Date) {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { start: iso(start), end: iso(end) };
}

/** Monday-anchored start of the week containing `d`. */
function weekStart(d: Date) {
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (copy.getDay() + 6) % 7;
  copy.setDate(copy.getDate() - day);
  return copy;
}

function agoLabel(from: Date, now: number) {
  const secs = Math.max(0, Math.round((now - from.getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

type EventRow = { task_id: string; event_type: string; occurred_at: string };

interface ExecutiveBriefProps {
  /** When true, the surrounding surface already supplies the page heading
   *  and subtitle, so this component renders its body only. */
  embedded?: boolean;
}

export default function ExecutiveBrief({ embedded = false }: ExecutiveBriefProps) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());

  const [staff, setStaff] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [assignOpen, setAssignOpen] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [definitions, setDefinitions] = useState<MetricDefinition[]>([]);
  const [snapshots, setSnapshots] = useState<MetricSnapshot[]>([]);

  const [commentTask, setCommentTask] = useState<Task | null>(null);
  const [commentText, setCommentText] = useState('');
  const [commentFlag, setCommentFlag] = useState(false);
  const [savingComment, setSavingComment] = useState(false);

  const firstLoad = useRef(true);

  const load = useCallback(async () => {
    if (firstLoad.current) setLoading(true);
    else setRefreshing(true);
    try {
      const { start, end } = monthBounds(new Date());
      const [people, allTasks, defs, snaps, eventRows, depts] = await Promise.all([
        getStaffDirectory(),
        getTasks(),
        getMetricDefinitions(),
        getSnapshots({ periodStart: start, periodEnd: end }),
        supabase
          .from('hr_task_events')
          .select('task_id, event_type, occurred_at')
          .order('occurred_at', { ascending: false })
          .limit(5000),
        getDepartments(),
      ]);

      setStaff(people);
      setDepartments(depts);
      setTasks(allTasks);
      setDefinitions(defs);
      setSnapshots(snaps);
      setEvents((eventRows.data ?? []) as EventRow[]);
      setUpdatedAt(new Date());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load the brief');
    } finally {
      firstLoad.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Plain 30 second polling. No websocket, no realtime channel.
   * The timer pauses while the tab is hidden and catches up on return.
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void load();
    }, 30000);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  /** Keeps the "Updated ..." line honest between polls. */
  useEffect(() => {
    const t = window.setInterval(() => setNowTick(Date.now()), 15000);
    return () => window.clearInterval(t);
  }, []);

  const staffById = useMemo(() => {
    const map: Record<string, Employee> = {};
    for (const p of staff) map[p.id] = p;
    return map;
  }, [staff]);

  const lastActivityByTask = useMemo(() => {
    const map: Record<string, string> = {};
    for (const e of events) {
      const prev = map[e.task_id];
      if (!prev || new Date(e.occurred_at).getTime() > new Date(prev).getTime()) {
        map[e.task_id] = e.occurred_at;
      }
    }
    return map;
  }, [events]);

  const commentCountByTask = useMemo(() => {
    const map: Record<string, number> = {};
    for (const e of events) {
      if (e.event_type !== 'note') continue;
      map[e.task_id] = (map[e.task_id] ?? 0) + 1;
    }
    return map;
  }, [events]);

  const tiles = useMemo(() => {
    const now = Date.now();
    const ws = weekStart(new Date()).getTime();
    const openTasks = tasks.filter((t) => !CLOSED.includes(t.status));
    return [
      { label: 'Open', value: openTasks.length },
      {
        label: 'Overdue',
        value: openTasks.filter((t) => !!t.due_at && new Date(t.due_at).getTime() < now).length,
      },
      { label: 'Awaiting review', value: tasks.filter((t) => t.status === 'submitted').length },
      { label: 'Blocked', value: tasks.filter((t) => String(t.status) === 'blocked').length },
      {
        label: 'Completed this week',
        value: tasks.filter(
          (t) =>
            t.status === 'completed' &&
            !!t.completed_at &&
            new Date(t.completed_at).getTime() >= ws,
        ).length,
      },
    ];
  }, [tasks]);

  const statuses = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) set.add(t.status);
    return Array.from(set).sort();
  }, [tasks]);

  /** One bar per person, segmented by status. Bars are in directory order, not ranked. */
  const perPerson = useMemo(() => {
    const rows: Record<string, Record<string, number | string>> = {};
    for (const t of tasks) {
      const id = t.assignee_employee_id || 'unassigned';
      const name = staffById[id]?.full_name ?? 'Unassigned';
      if (!rows[id]) rows[id] = { person: name };
      rows[id][t.status] = ((rows[id][t.status] as number) ?? 0) + 1;
    }
    return Object.values(rows);
  }, [tasks, staffById]);

  const statusMix = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
    return Object.entries(counts).map(([status, value]) => ({
      status,
      name: humanize(status),
      value,
    }));
  }, [tasks]);

  const openRows = useMemo(() => {
    const now = Date.now();
    return tasks
      .filter((t) => !CLOSED.includes(t.status))
      .map((t) => {
        const person = staffById[t.assignee_employee_id];
        const last = lastActivityByTask[t.id] ?? t.created_at;
        const lastMs = last ? new Date(last).getTime() : now;
        return {
          task: t,
          staffId: person?.id ?? null,
          personName: person?.full_name ?? 'Unassigned',
          position: person?.current_assignment?.role_title ?? '—',
          department: person?.current_assignment?.department_name ?? '—',
          daysIdle: Math.max(0, Math.floor((now - lastMs) / 86400000)),
          overdue: !!t.due_at && new Date(t.due_at).getTime() < now,
          comments: commentCountByTask[t.id] ?? 0,
        };
      })
      .sort((a, b) => {
        if (b.daysIdle !== a.daysIdle) return b.daysIdle - a.daysIdle;
        const av = a.task.due_at ? new Date(a.task.due_at).getTime() : Number.POSITIVE_INFINITY;
        const bv = b.task.due_at ? new Date(b.task.due_at).getTime() : Number.POSITIVE_INFINITY;
        return av - bv;
      });
  }, [tasks, staffById, lastActivityByTask, commentCountByTask]);

  /** Metric values for the current month, one block per person. Read only. */
  const monthlyByPerson = useMemo(() => {
    const activeDefs = definitions.filter((d) => d.active);
    if (activeDefs.length === 0) return [];
    const byStaff: Record<string, MetricSnapshot[]> = {};
    for (const s of snapshots) {
      const key = String(s.subject_id ?? '');
      if (!key) continue;
      if (!byStaff[key]) byStaff[key] = [];
      byStaff[key].push(s);
    }
    return Object.entries(byStaff).map(([staffId, snaps]) => ({
      staffId,
      name: staffById[staffId]?.full_name ?? 'Unknown',
      values: activeDefs.map((def) => {
        const snap = snaps.find((s) => s.metric_definition_id === def.id);
        return { def, value: snap ? snap.value : null };
      }),
    }));
  }, [definitions, snapshots, staffById]);

  const saveComment = async () => {
    if (!commentTask) return;
    const text = commentText.trim();
    if (!text) {
      toast.error('Write something first');
      return;
    }
    setSavingComment(true);
    try {
      await addTaskEvent({
        taskId: commentTask.id,
        eventType: 'note',
        note: text,
        metadata: commentFlag ? { flag: 'attention' } : {},
      });
      toast.success('Comment saved');
      setCommentTask(null);
      setCommentText('');
      setCommentFlag(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the comment');
    } finally {
      setSavingComment(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className={embedded ? 'space-y-5' : 'space-y-5'}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Updated {updatedAt ? agoLabel(updatedAt, nowTick) : '—'}
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={refreshing}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setAssignOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Assign task
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {tiles.map((tile) => (
          <Card key={tile.label}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{tile.label}</p>
              <p className="text-2xl font-bold text-foreground mt-1">{tile.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Tasks per person by status</CardTitle>
          </CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={perPerson} margin={{ top: 8, right: 8, left: 0, bottom: 24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="person"
                  tick={{ fontSize: 10 }}
                  interval={0}
                  angle={-25}
                  textAnchor="end"
                  height={60}
                />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {statuses.map((status) => (
                  <Bar
                    key={status}
                    dataKey={status}
                    name={humanize(status)}
                    stackId="tasks"
                    fill={fillFor(status)}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Overall status mix</CardTitle>
          </CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={statusMix}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={55}
                  outerRadius={85}
                  paddingAngle={2}
                >
                  {statusMix.map((entry) => (
                    <Cell key={entry.status} fill={fillFor(entry.status)} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <TasksList />

      <PartnerOpsProductionSection />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Open work</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead>Position</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Task</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Days since last activity</TableHead>
                  <TableHead className="text-right">Comment</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {openRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-sm text-muted-foreground py-8">
                      Nothing open right now.
                    </TableCell>
                  </TableRow>
                )}
                {openRows.map((row) => (
                  <TableRow key={row.task.id}>
                    <TableCell className="whitespace-nowrap">
                      {row.staffId ? (
                        <Link
                          to={`/hr/dashboard/scorecard/${row.staffId}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {row.personName}
                        </Link>
                      ) : (
                        row.personName
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {row.position}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {row.department}
                    </TableCell>
                    <TableCell className="max-w-[260px] truncate" title={row.task.title}>
                      {row.task.title}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex px-2 py-0.5 rounded-full text-[11px] ${
                          STATUS_PILL[row.task.status] ?? 'bg-muted text-foreground'
                        }`}
                      >
                        {humanize(row.task.status)}
                      </span>
                    </TableCell>
                    <TableCell
                      className={`whitespace-nowrap ${row.overdue ? 'text-destructive font-medium' : ''}`}
                    >
                      {formatDate(row.task.due_at)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.daysIdle}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setCommentTask(row.task);
                          setCommentText('');
                          setCommentFlag(false);
                        }}
                      >
                        <MessageSquarePlus className="h-3.5 w-3.5 mr-1" />
                        Comment
                        {row.comments > 0 && (
                          <span className="ml-1 text-xs text-muted-foreground">({row.comments})</span>
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">This month</h3>
        {monthlyByPerson.length === 0 && (
          <p className="text-sm text-muted-foreground">No metric values recorded for this month.</p>
        )}
        {monthlyByPerson.map((person) => (
          <Card key={person.staffId}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{person.name}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
                {person.values.map(({ def, value }) => (
                  <div key={def.id} className="rounded-xl border border-border p-3">
                    <div className="flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-full ${dotClass(value, def)}`} />
                      <p className="text-[11px] text-muted-foreground truncate" title={def.name}>
                        {def.name}
                      </p>
                    </div>
                    <p className="text-lg font-semibold text-foreground mt-1">
                      {formatValue(value, def.unit)}
                    </p>
                    {def.target_value !== null && def.target_value !== undefined && (
                      <p className="text-[10px] text-muted-foreground">
                        Target {formatValue(def.target_value, def.unit)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <TaskFormDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        title="Assign task"
        departments={departments}
        assignees={staff}
        onCreated={() => void load()}
      />

      <Dialog open={!!commentTask} onOpenChange={(open) => !open && setCommentTask(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Add a comment</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground -mt-2">{commentTask?.title}</p>
          <Textarea
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="What should the record say?"
            rows={4}
          />
          <div className="flex items-center gap-2">
            <Checkbox
              id="brief-flag"
              checked={commentFlag}
              onCheckedChange={(v) => setCommentFlag(v === true)}
            />
            <Label htmlFor="brief-flag" className="text-sm font-normal">
              Flag for attention
            </Label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCommentTask(null)} disabled={savingComment}>
              Cancel
            </Button>
            <Button onClick={() => void saveComment()} disabled={savingComment}>
              {savingComment ? 'Saving…' : 'Save comment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
