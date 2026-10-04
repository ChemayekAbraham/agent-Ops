import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarClock } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  addTaskEvent,
  getDepartments,
  getStaffDirectory,
  getTask,
  getTaskEvents,
  getTaskEventActorNames,
} from '../api';
import type { Department, Employee, Task, TaskEvent } from '../types';
import {
  TRANSITION_NOTE_LABELS,
  charsStillNeeded,
  isNoteRequired,
  isValidTransitionNote,
} from './TransitionNoteDialog';

/** Buttons available per current task status. */
const ACTIONS: { key: string; label: string; event: string }[] = [
  { key: 'start', label: 'Start', event: 'started' },
  { key: 'block', label: 'Block', event: 'blocked' },
  { key: 'unblock', label: 'Unblock', event: 'unblocked' },
  { key: 'submit', label: 'Submit for review', event: 'submitted' },
  { key: 'complete', label: 'Complete', event: 'completed' },
  { key: 'reopen', label: 'Reopen', event: 'reopened' },
  { key: 'cancel', label: 'Cancel', event: 'cancelled' },
];

const ALLOWED_BY_STATUS: Record<string, string[]> = {
  open: ['start', 'block', 'cancel'],
  in_progress: ['block', 'submit', 'complete', 'cancel'],
  blocked: ['unblock', 'cancel'],
  submitted: ['complete', 'reopen', 'cancel'],
  completed: ['reopen'],
  cancelled: ['reopen'],
};

const STATUS_PILL: Record<string, string> = {
  open: 'bg-muted text-muted-foreground',
  in_progress: 'bg-primary/10 text-primary',
  blocked: 'bg-destructive/10 text-destructive',
  submitted: 'bg-amber-500/10 text-amber-600',
  completed: 'bg-emerald-500/10 text-emerald-600',
  cancelled: 'bg-muted text-muted-foreground line-through',
};

const PRIORITY_PILL: Record<string, string> = {
  low: 'bg-muted text-muted-foreground',
  normal: 'bg-primary/10 text-primary',
  high: 'bg-amber-500/10 text-amber-600',
  urgent: 'bg-destructive/10 text-destructive',
};

function pretty(value: string) {
  return value.replace(/_/g, ' ');
}

function formatWhen(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [task, setTask] = useState<Task | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [actors, setActors] = useState<Record<string, string>>({});
  const [staff, setStaff] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [pendingAction, setPendingAction] = useState<(typeof ACTIONS)[number] | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [t, evs, people, depts] = await Promise.all([
        getTask(id),
        getTaskEvents(id),
        getStaffDirectory(),
        getDepartments(),
      ]);
      setTask(t);
      setEvents(evs);
      setStaff(people);
      setDepartments(depts);
      setActors(await getTaskEventActorNames(evs.map((e) => e.actor_employee_id)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load this task');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const assigneeName = useMemo(() => {
    const match = staff.find((s) => s.id === task?.assignee_employee_id);
    return match?.full_name || 'Unassigned';
  }, [staff, task]);

  const departmentName = useMemo(
    () => departments.find((d) => d.id === task?.department_id)?.name ?? '—',
    [departments, task],
  );

  const visibleActions = useMemo(() => {
    if (!task) return [];
    const allowed = ALLOWED_BY_STATUS[task.status] ?? [];
    return ACTIONS.filter((a) => allowed.includes(a.key));
  }, [task]);

  async function recordEvent(
    action: (typeof ACTIONS)[number],
    noteValue: string,
  ) {
    if (!id) return;
    if (isNoteRequired(action.event) && !isValidTransitionNote(noteValue)) {
      toast.error('A note is required for this action');
      return;
    }
    setSaving(true);
    try {
      // Append-only: a database trigger moves hr_tasks.status.
      await addTaskEvent({
        taskId: id,
        eventType: action.event,
        note: noteValue.trim() ? noteValue.trim() : null,
      });
      toast.success(`${action.label} recorded`);
      setPendingAction(null);
      setNote('');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not record this action');
    } finally {
      setSaving(false);
    }
  }

  function confirmAction() {
    if (!pendingAction) return;
    void recordEvent(pendingAction, note);
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!task) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          This task could not be found, or you do not have access to it.
        </CardContent>
      </Card>
    );
  }

  const overdue =
    task.due_at &&
    new Date(task.due_at) < new Date() &&
    !['completed', 'cancelled'].includes(task.status);

  // The required set is the label map's keys — never a second list.
  const noteRequired = !!pendingAction && isNoteRequired(pendingAction.event);
  const noteMissing = charsStillNeeded(note);

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" onClick={() => navigate('/hr/dashboard/tasks')}>
        <ArrowLeft className="mr-2 h-4 w-4" /> Back to tasks
      </Button>

      <Card>
        <CardContent className="space-y-4 p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="font-mono text-xs uppercase text-muted-foreground">{task.ref}</p>
              <h2 className="text-xl font-semibold">{task.title}</h2>
            </div>
            <span
              className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${
                STATUS_PILL[task.status] ?? 'bg-muted text-muted-foreground'
              }`}
            >
              {pretty(task.status)}
            </span>
          </div>

          <p className="whitespace-pre-wrap text-sm text-muted-foreground">
            {task.description || 'No description provided.'}
          </p>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-xs uppercase text-muted-foreground">Assignee</p>
              <p className="text-sm font-medium">{assigneeName}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-muted-foreground">Department</p>
              <p className="text-sm font-medium">{departmentName}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-muted-foreground">Priority</p>
              <span
                className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                  PRIORITY_PILL[task.priority] ?? 'bg-muted text-muted-foreground'
                }`}
              >
                {pretty(task.priority)}
              </span>
            </div>
            <div>
              <p className="text-xs uppercase text-muted-foreground">Due</p>
              <p
                className={`flex items-center gap-1 text-sm font-medium ${
                  overdue ? 'text-destructive' : ''
                }`}
              >
                <CalendarClock className="h-3.5 w-3.5" />
                {task.due_at ? new Date(task.due_at).toLocaleDateString() : 'No due date'}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap gap-2 p-6">
          {visibleActions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No actions available for this status.</p>
          ) : (
            visibleActions.map((action) => (
              <Button
                key={action.key}
                variant={action.key === 'cancel' ? 'destructive' : 'default'}
                size="sm"
                disabled={saving}
                onClick={() => {
                  setNote('');
                  if (isNoteRequired(action.event)) {
                    setPendingAction(action);
                  } else {
                    void recordEvent(action, '');
                  }
                }}
              >
                {action.label}
              </Button>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <h3 className="mb-4 text-sm font-semibold uppercase text-muted-foreground">Timeline</h3>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events recorded yet.</p>
          ) : (
            <ol className="relative space-y-6 border-l border-border pl-6">
              {events.map((event) => (
                <li key={event.id} className="relative">
                  <span className="absolute -left-[1.6rem] top-1.5 h-2.5 w-2.5 rounded-full bg-primary" />
                  <p className="text-sm font-medium capitalize">{pretty(event.event_type)}</p>
                  <p className="text-xs text-muted-foreground">
                    {actors[event.actor_employee_id] ?? 'Unknown'} · {formatWhen(event.at)}
                  </p>
                  {event.note ? (
                    <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                      {event.note}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!pendingAction} onOpenChange={(open) => !open && setPendingAction(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{pendingAction?.label}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="task-event-note">
              {noteRequired
                ? TRANSITION_NOTE_LABELS[pendingAction!.event]
                : 'Note (optional)'}
            </Label>
            <Textarea
              id="task-event-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add context for this action"
              rows={4}
            />
            {noteRequired && !isValidTransitionNote(note) && (
              <p className="text-[11px] text-muted-foreground">
                {noteMissing} more character{noteMissing === 1 ? '' : 's'} needed
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingAction(null)} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={confirmAction}
              disabled={saving || (noteRequired && !isValidTransitionNote(note))}
            >
              {saving ? 'Saving…' : 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
