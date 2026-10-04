import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { createTask, getMyStaff } from '@/hr/api';
import type { Department, Employee } from '@/hr/types';

export const NONE = '__none__';

export const PRIORITY_OPTIONS = ['low', 'normal', 'high', 'urgent'] as const;

function humanize(value: string) {
  return (value || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

interface TaskFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  departments: Department[];
  /** People that may be picked as assignee. Ignored when fixedAssigneeStaffId is set. */
  assignees?: Employee[];
  /**
   * When provided the assignee is locked to this staff id and no assignee
   * picker is shown. Used by My Work, where the assignee is always the
   * signed-in person.
   */
  fixedAssigneeStaffId?: string | null;
  defaultDepartmentId?: string | null;
  onCreated?: () => void;
}

/**
 * The single task creation dialog for the HR module. Used by Tasks,
 * the Executive Brief ("Assign task") and My Work ("Log a task").
 */
export default function TaskFormDialog({
  open,
  onOpenChange,
  title = 'New task',
  departments,
  assignees = [],
  fixedAssigneeStaffId = null,
  defaultDepartmentId = null,
  onCreated,
}: TaskFormDialogProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    title: '',
    description: '',
    departmentId: defaultDepartmentId ?? '',
    assigneeId: fixedAssigneeStaffId ?? NONE,
    priority: 'normal',
    dueDate: '',
  });

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm({
      title: '',
      description: '',
      departmentId: defaultDepartmentId ?? '',
      assigneeId: fixedAssigneeStaffId ?? NONE,
      priority: 'normal',
      dueDate: '',
    });
  }, [open, defaultDepartmentId, fixedAssigneeStaffId]);

  const missing: string[] = [];
  if (!form.title.trim()) missing.push('title');
  if (!form.departmentId) missing.push('department');
  const canSave = missing.length === 0 && !saving;

  const handleCreate = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      let createdByStaffId: string | null = null;
      try {
        createdByStaffId = (await getMyStaff())?.id ?? null;
      } catch {
        createdByStaffId = null;
      }
      // createTask also inserts the opening "created" event.
      await createTask({
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        departmentId: form.departmentId,
        assigneeStaffId: fixedAssigneeStaffId
          ? fixedAssigneeStaffId
          : form.assigneeId === NONE
            ? null
            : form.assigneeId,
        createdByStaffId,
        origin: fixedAssigneeStaffId ? 'self_initiated' : 'assigned',
        priority: form.priority,
        dueAt: form.dueDate ? new Date(`${form.dueDate}T17:00:00`).toISOString() : null,
      });
      toast.success('Task created');
      onOpenChange(false);
      onCreated?.();
    } catch (err) {
      // The database refused the insert. Show it verbatim, never swallow it.
      const message = err instanceof Error ? err.message : 'Could not create the task.';
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Title</Label>
            <Input
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="What needs doing?"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Description</Label>
            <Textarea
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Context, definition of done, links"
              rows={3}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Department</Label>
              <Select
                value={form.departmentId}
                onValueChange={(v) => setForm((f) => ({ ...f, departmentId: v }))}
              >
                <SelectTrigger className="h-9 text-xs">
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
            </div>

            {!fixedAssigneeStaffId && (
              <div className="space-y-1.5">
                <Label className="text-xs">Assignee</Label>
                <Select
                  value={form.assigneeId}
                  onValueChange={(v) => setForm((f) => ({ ...f, assigneeId: v }))}
                >
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Unassigned</SelectItem>
                    {assignees.map((e) => (
                      <SelectItem key={e.id} value={e.id}>
                        {e.full_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs">Priority</Label>
              <Select value={form.priority} onValueChange={(v) => setForm((f) => ({ ...f, priority: v }))}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_OPTIONS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {humanize(p)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Due date</Label>
              <Input
                type="date"
                value={form.dueDate}
                onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
              />
            </div>
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
          {error && <p className="w-full text-[11px] text-destructive">{error}</p>}
          {missing.length > 0 && (
            <p className="text-[11px] text-muted-foreground w-full">
              Still needed: {missing.join(', ')}
            </p>
          )}
          <Button className="w-full" disabled={!canSave} onClick={() => void handleCreate()}>
            {saving ? 'Saving…' : 'Create task'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
