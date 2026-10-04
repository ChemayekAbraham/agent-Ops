import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Loader2 } from 'lucide-react';
import {
  Line,
  LineChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
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
  getEmployees,
  getMetricDefinitions,
  getMyStaff,
  getSnapshots,
  getTasks,
  getUnacknowledgedTasks,
} from '@/hr/api';
import { supabase } from '@/hr/api/client';
import { setMyWorkBadge } from '@/hr/lib/myWorkBadge';
import type { Department, Employee, MetricDefinition, MetricSnapshot, Task } from '@/hr/types';
import TaskFormDialog from './TaskFormDialog';
import TransitionNoteDialog, {
  isNoteRequired,
  isValidTransitionNote,
} from './TransitionNoteDialog';
import MyLeaveRequests from './MyLeaveRequests';


interface LeadScoreboardRow {
  lead_user_id: string;
  agents_attached: number;
  notes_approved: number;
  override_total: number;
  target_value: number;
  state: string;
  agents_attached_month?: number;
  agents_target?: number;
  agents_state?: string;
}

function partnerMonthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function partnerStateText(state?: string) {
  switch (state) {
    case 'on_track': return 'text-emerald-600';
    case 'amber': return 'text-amber-600';
    case 'red': return 'text-destructive';
    default: return 'text-muted-foreground';
  }
}

function partnerStateBorder(state?: string) {
  switch (state) {
    case 'on_track': return 'border-l-4 border-l-emerald-500';
    case 'amber': return 'border-l-4 border-l-amber-500';
    case 'red': return 'border-l-4 border-l-destructive';
    default: return 'border-l-4 border-l-muted';
  }
}

/**
 * Partner growth production for the signed-in user, shown only when they
 * currently lead at least one attached proxy agent. Renders nothing otherwise.
 */
function PartnerLeadProduction() {
  const [row, setRow] = useState<LeadScoreboardRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: auth } = await supabase.auth.getUser();
        const uid = auth?.user?.id;
        if (!uid) return;
        const { data: leadRows, error: leadError } = await supabase
          .from('partner_lead_assignments' as never)
          .select('id')
          .eq('lead_user_id', uid)
          .is('detached_at', null)
          .limit(1);
        if (leadError || !leadRows || leadRows.length === 0) return;
        const { data, error } = await supabase.rpc('partner_ops_scoreboard' as never, {
          p_month: partnerMonthStart(),
        } as never);
        if (error) return;
        const mine = ((data ?? []) as unknown as LeadScoreboardRow[]).find(
          (r) => r.lead_user_id === uid,
        );
        if (!cancelled && mine) setRow(mine);
      } catch {
        // Silent: this panel is additive and must never block My Work.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!row) return null;

  const agents = Number(row.agents_attached_month ?? row.agents_attached ?? 0);
  const agentsTarget = Number(row.agents_target ?? 0);
  const notes = Number(row.notes_approved ?? 0);
  const notesTarget = Number(row.target_value ?? 0);
  const override = Number(row.override_total ?? 0);

  return (
    <Card className={partnerStateBorder(row.state)}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Partner growth production — this month</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 pt-0 sm:grid-cols-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Agents attached</p>
          <p className={`text-sm font-semibold ${partnerStateText(row.agents_state)}`}>
            {agents} / {agentsTarget}
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Notes approved</p>
          <p className={`text-sm font-semibold ${partnerStateText(row.state)}`}>
            {notes} / {notesTarget}
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Override earned</p>
          <p className="text-sm font-semibold text-foreground">
            UGX {override.toLocaleString('en-UG')}
          </p>
        </div>
      </CardContent>
    </Card>
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
};

const PRIORITY_DOT: Record<string, string> = {
  low: 'bg-muted-foreground',
  normal: 'bg-blue-500',
  high: 'bg-amber-500',
  urgent: 'bg-destructive',
};


/** A flagged comment on one of my tasks that I have not yet acknowledged. */
interface AttentionItem {
  eventId: string;
  taskId: string;
  taskTitle: string;
  note: string;
  authorName: string;
  at: string;
}

/** Raw note event shape, read append-only from hr_task_events. */
interface NoteEventRow {
  id: string;
  task_id: string;
  actor_user_id: string;
  occurred_at: string;
  note: string | null;
  metadata: Record<string, unknown> | null;
}

function flagOf(metadata: Record<string, unknown> | null): string {
  const raw = metadata && typeof metadata === 'object' ? (metadata as { flag?: unknown }).flag : null;
  return typeof raw === 'string' ? raw : '';
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

function formatDateTime(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
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
 * Traffic light from the metric's own direction and thresholds.
 * No target -> grey, no judgement.
 */
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

interface MyWorkProps {
  /** When true, the surrounding surface already supplies the page heading
   *  and subtitle, so this component renders its body only. */
  embedded?: boolean;
}

export default function MyWork({ embedded = false }: MyWorkProps) {
  const [loading, setLoading] = useState(true);
  const [staff, setStaff] = useState<Employee | null>(null);
  const [definitions, setDefinitions] = useState<MetricDefinition[]>([]);
  const [snapshots, setSnapshots] = useState<MetricSnapshot[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [notePrompt, setNotePrompt] = useState<
    { taskId: string; eventType: 'completed' } | null
  >(null);
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  const [busyEventId, setBusyEventId] = useState<string | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [unstarted, setUnstarted] = useState<{ task: Task; assignedBy: string }[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [live, setLive] = useState(false);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const me = await getMyStaff();
      setStaff(me);
      if (!me) return;

      const { start, end } = monthBounds(new Date());
      const [defs, snaps, myTasks, depts] = await Promise.all([
        getMetricDefinitions(me.current_assignment?.department_id),
        getSnapshots({ staffId: me.id, periodStart: start, periodEnd: end }),
        getTasks({ assigneeEmployeeId: me.id }),
        getDepartments(),
      ]);

      setDepartments(depts);
      setDefinitions(defs);
      setSnapshots(snaps);
      setTasks(myTasks);

      // Work handed to me by someone else that I have not started yet.
      const handed = await getUnacknowledgedTasks(me.id);
      if (handed.length > 0) {
        const staffList = await getEmployees();
        const nameByStaff = Object.fromEntries(staffList.map((s) => [s.id, s.full_name || 'Unknown']));
        setUnstarted(
          handed.map((t) => ({
            task: t,
            assignedBy: nameByStaff[t.assigner_employee_id ?? ''] ?? 'Unknown',
          })),
        );
      } else {
        setUnstarted([]);
      }
      setMyWorkBadge(handed.length);

      // Flagged comments awaiting my acknowledgement. Read-only pass over the
      // append-only event log: a later `acknowledged` note cancels an earlier
      // `attention` note on the same task.
      const taskIds = myTasks.map((t) => t.id);
      if (taskIds.length > 0) {
        const { data: noteRows } = await supabase
          .from('hr_task_events')
          .select('id, task_id, actor_user_id, occurred_at, note, metadata')
          .in('task_id', taskIds)
          .eq('event_type', 'note')
          .order('occurred_at', { ascending: true });

        const notes = (noteRows ?? []) as unknown as NoteEventRow[];
        const lastAck: Record<string, number> = {};
        for (const row of notes) {
          if (flagOf(row.metadata) !== 'acknowledged') continue;
          const ts = new Date(row.occurred_at).getTime();
          if (!lastAck[row.task_id] || ts > lastAck[row.task_id]) lastAck[row.task_id] = ts;
        }

        const pending = notes.filter(
          (row) =>
            flagOf(row.metadata) === 'attention' &&
            new Date(row.occurred_at).getTime() > (lastAck[row.task_id] ?? -Infinity),
        );

        let nameByUser: Record<string, string> = {};
        const authorIds = Array.from(new Set(pending.map((p) => p.actor_user_id).filter(Boolean)));
        if (authorIds.length > 0) {
          const { data: authorRows } = await supabase
            .from('profiles')
            .select('id, full_name')
            .in('id', authorIds);
          nameByUser = Object.fromEntries(
            ((authorRows ?? []) as { id: string; full_name: string | null }[]).map((p) => [
              p.id,
              p.full_name || 'Unknown',
            ]),
          );
        }

        const titleById = Object.fromEntries(myTasks.map((t) => [t.id, t.title]));
        setAttention(
          pending
            .map((row) => ({
              eventId: row.id,
              taskId: row.task_id,
              taskTitle: titleById[row.task_id] ?? 'Task',
              note: row.note ?? '',
              authorName: nameByUser[row.actor_user_id] ?? 'Unknown',
              at: row.occurred_at,
            }))
            .reverse(),
        );
      } else {
        setAttention([]);
      }

    } catch (e) {
      if (!opts?.silent) toast.error(e instanceof Error ? e.message : 'Could not load your work');
    } finally {
      setLoading(false);
      setLastUpdated(new Date());
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Keeps the completion trend current without the person touching anything:
   * a 60s poll and a refresh whenever the tab comes back into view.
   */
  useEffect(() => {
    if (!staff?.id) return;

    let timer: number | undefined;
    const refresh = () => void load({ silent: true });

    // No Realtime channel: hr_tasks and hr_task_events are not in the
    // publication, so it never reached a live state (doc 147). The 60s poll
    // and the on-focus refresh below keep the view current.

    timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 60_000);

    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    return () => {
      if (timer) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      setLive(false);
    };
  }, [staff?.id, load]);

  const tiles = useMemo(() => {
    const active = definitions.filter((d) => d.active);
    return active.map((def) => {
      const snap = snapshots.find((s) => s.metric_definition_id === def.id);
      return {
        def,
        value: snap ? snap.value : null,
      };
    });
  }, [definitions, snapshots]);

  const openTasks = useMemo(() => {
    const now = Date.now();
    return tasks
      .filter((t) => !CLOSED.includes(t.status))
      .sort((a, b) => {
        const av = a.due_at ? new Date(a.due_at).getTime() : Number.POSITIVE_INFINITY;
        const bv = b.due_at ? new Date(b.due_at).getTime() : Number.POSITIVE_INFINITY;
        return av - bv;
      })
      .map((t) => ({
        task: t,
        overdue: !!t.due_at && new Date(t.due_at).getTime() < now,
      }));
  }, [tasks]);

  const finishedTasks = useMemo(() => {
    return tasks
      .filter((t) => CLOSED.includes(t.status))
      .sort((a, b) => {
        const aCompleted = a.completed_at ? new Date(a.completed_at).getTime() : null;
        const bCompleted = b.completed_at ? new Date(b.completed_at).getTime() : null;
        if (aCompleted && bCompleted) return bCompleted - aCompleted;
        if (aCompleted) return -1;
        if (bCompleted) return 1;
        const aCreated = new Date(a.created_at).getTime();
        const bCreated = new Date(b.created_at).getTime();
        return bCreated - aCreated;
      });
  }, [tasks]);

  /** Last 30 days of completed ÷ created, straight off this person's hr_tasks rows. */
  const trend = useMemo(() => {
    const buckets: { key: number; label: string; created: number; completed: number }[] = [];
    const dayStart = (d: Date) => {
      const x = new Date(d);
      x.setHours(0, 0, 0, 0);
      return x;
    };
    const today = dayStart(new Date());
    for (let i = 29; i >= 0; i -= 1) {
      const start = new Date(today);
      start.setDate(start.getDate() - i);
      buckets.push({
        key: start.getTime(),
        label: start.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
        created: 0,
        completed: 0,
      });
    }
    const indexFor = (iso: string | null) => {
      if (!iso) return -1;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return -1;
      return buckets.findIndex((b) => b.key === dayStart(d).getTime());
    };
    for (const t of tasks) {
      const ci = indexFor(t.created_at);
      if (ci >= 0) buckets[ci].created += 1;
      const xi = t.status === 'completed' ? indexFor(t.completed_at) : -1;
      if (xi >= 0) buckets[xi].completed += 1;
    }
    return buckets.map((b) => ({
      label: b.label,
      created: b.created,
      completed: b.completed,
    }));
  }, [tasks]);

  const act = async (
    taskId: string,
    eventType: 'started' | 'submitted' | 'completed',
    note?: string,
  ) => {
    setBusyTaskId(taskId);
    try {
      if (isNoteRequired(eventType) && !isValidTransitionNote(note || '')) {
        toast.error('A note is required for this action');
        return;
      }
      await addTaskEvent({ taskId, eventType, note: note && note.trim() ? note.trim() : null });
      toast.success(`Task ${eventType}`);
      await load({ silent: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update the task');
    } finally {
      setBusyTaskId(null);
    }
  };

  /**
   * Acknowledging INSERTS one new note event. The original comment row is
   * never updated and never deleted.
   */
  const acknowledge = async (item: AttentionItem) => {
    setBusyEventId(item.eventId);
    try {
      await addTaskEvent({
        taskId: item.taskId,
        eventType: 'note',
        note: 'Acknowledged',
        metadata: { flag: 'acknowledged', acknowledges_event_id: item.eventId },
      });
      toast.success('Acknowledged');
      await load({ silent: true });

    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not acknowledge');
    } finally {
      setBusyEventId(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!staff) {
    return (
      <p className="text-sm text-muted-foreground">
        You are not yet enrolled in performance tracking.
      </p>
    );
  }

  return (
    <div className={embedded ? 'space-y-5' : 'space-y-5'}>
      
      <PartnerLeadProduction />
      <MyLeaveRequests />
      {unstarted.length > 0 && (
        <Card className="border-primary/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              {unstarted.length} {unstarted.length === 1 ? 'task' : 'tasks'} assigned to you, not yet started
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            {unstarted.map(({ task, assignedBy }) => (
              <div
                key={task.id}
                className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0">
                  <Link
                    to={`/hr/dashboard/tasks/${task.id}`}
                    className="text-sm font-semibold text-foreground hover:underline"
                  >
                    {task.title}
                  </Link>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Assigned by {assignedBy} · {formatDateTime(task.created_at)} · Due {formatDate(task.due_at)}
                  </p>
                </div>
                <Button
                  size="sm"
                  className="h-7 shrink-0 px-3 text-[11px]"
                  disabled={busyTaskId === task.id}
                  onClick={() => act(task.id, 'started')}
                >
                  {busyTaskId === task.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Start'}
                </Button>

              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          to={`/hr/dashboard/scorecard/${staff.id}`}
          className="text-sm font-medium text-primary hover:underline"
        >
          View my full scorecard
        </Link>
        <Button size="sm" onClick={() => setLogOpen(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Log a task
        </Button>
      </div>

      {attention.length > 0 && (
        <Card className="border-amber-500/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Needs your attention</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            {attention.map((item) => (
              <div
                key={item.eventId}
                className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0">
                  <Link
                    to={`/hr/dashboard/tasks/${item.taskId}`}
                    className="text-sm font-semibold text-foreground hover:underline"
                  >
                    {item.taskTitle}
                  </Link>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{item.note}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {item.authorName} · {formatDateTime(item.at)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0 px-2 text-[11px]"
                  disabled={busyEventId === item.eventId}
                  onClick={() => acknowledge(item)}
                >
                  Acknowledge
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {tiles.length === 0 ? (
          <p className="col-span-full text-sm text-muted-foreground">
            No metrics are configured for your department yet.
          </p>
        ) : (
          tiles.map(({ def, value }) => (
            <Card key={def.id}>
              <CardContent className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[11px] font-medium leading-tight text-muted-foreground">
                    {def.name}
                  </p>
                  <span className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${dotClass(value, def)}`} />
                </div>
                <p className="mt-1.5 text-lg font-bold text-foreground">
                  {formatValue(value, def.unit)}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {def.target_value === null || def.target_value === undefined
                    ? 'No target'
                    : `Target ${formatValue(def.target_value, def.unit)}`}
                </p>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">My open tasks</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {openTasks.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">Nothing open right now</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Task</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {openTasks.map(({ task, overdue }) => (
                  <TableRow key={task.id}>
                    <TableCell className="max-w-[280px]">
                      <Link
                        to={`/hr/dashboard/tasks/${task.id}`}
                        className="text-sm font-medium text-foreground hover:underline"
                      >
                        {task.title}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        <span className={`h-2 w-2 rounded-full ${PRIORITY_DOT[task.priority] ?? 'bg-muted-foreground'}`} />
                        {humanize(task.priority)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${STATUS_PILL[task.status] ?? 'bg-muted text-foreground'}`}>
                        {humanize(task.status)}
                      </span>
                    </TableCell>
                    <TableCell className={overdue ? 'text-xs font-semibold text-destructive' : 'text-xs'}>
                      {formatDate(task.due_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {['open', 'assigned', 'returned'].includes(String(task.status)) && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[10px]"
                            disabled={busyTaskId === task.id}
                            onClick={() => act(task.id, 'started')}
                          >
                            {busyTaskId === task.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : 'Start'}
                          </Button>
                        )}
                        {['in_progress', 'blocked'].includes(String(task.status)) && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[10px]"
                            disabled={busyTaskId === task.id}
                            onClick={() => act(task.id, 'submitted')}
                          >
                            {busyTaskId === task.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : 'Submit'}
                          </Button>
                        )}
                        {task.status === 'submitted' && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[10px]"
                            disabled={busyTaskId === task.id}
                            onClick={() => setNotePrompt({ taskId: task.id, eventType: 'completed' })}
                          >
                            {busyTaskId === task.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : 'Complete'}
                          </Button>
                        )}

                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">My finished tasks</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {finishedTasks.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">Nothing finished yet</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ref</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Completed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {finishedTasks.map((task) => (
                  <TableRow key={task.id}>
                    <TableCell className="text-xs text-muted-foreground">{task.ref}</TableCell>
                    <TableCell className="max-w-[280px]">
                      <Link
                        to={`/hr/dashboard/tasks/${task.id}`}
                        className="text-sm font-medium text-foreground hover:underline"
                      >
                        {task.title}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${STATUS_PILL[task.status] ?? 'bg-muted text-foreground'}`}>
                        {humanize(task.status)}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs">{formatDate(task.completed_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm">Tasks created and completed · last 30 days</CardTitle>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span
                  className={
                    live
                      ? 'h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse'
                      : 'h-1.5 w-1.5 rounded-full bg-muted-foreground/50'
                  }
                />
                {live ? 'Live' : 'Auto-refresh'}
              </span>
              {lastUpdated && <span>· updated {lastUpdated.toLocaleTimeString('en-GB')}</span>}
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() => void load({ silent: true })}
              >
                Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trend} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={16} />
              <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
              <Tooltip
                formatter={(v: number, name) => [
                  `${v}`,
                  name === 'created' ? 'Tasks created' : 'Tasks completed',
                ]}
                labelFormatter={(l) => `${l}`}
              />
              <Line
                type="monotone"
                dataKey="created"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                dot={{ r: 3 }}
              />
              <Line
                type="monotone"
                dataKey="completed"
                stroke="hsl(var(--muted-foreground))"
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* The assignee is always the signed-in person; no picker is shown. */}
      <TaskFormDialog
        open={logOpen}
        onOpenChange={setLogOpen}
        title="Log a task"
        departments={departments}
        fixedAssigneeStaffId={staff.id}
        defaultDepartmentId={staff.current_assignment?.department_id ?? null}
        onCreated={() => void load({ silent: true })}
      />

      {notePrompt && (
        <TransitionNoteDialog
          eventType={notePrompt.eventType}
          open
          busy={busyTaskId === notePrompt.taskId}
          onClose={() => setNotePrompt(null)}
          onConfirm={async (note) => {
            const target = notePrompt;
            await act(target.taskId, target.eventType, note);
            setNotePrompt(null);
          }}
        />
      )}
    </div>
  );
}
