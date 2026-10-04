/**
 * HR data contracts — Tasks
 *
 * Part of the HR module contract. Do not add, rename or remove fields.
 */
export type TaskOrigin = 'assigned' | 'self_initiated' | 'recurring';

export type TaskStatus =
  | 'draft'
  | 'assigned'
  | 'acknowledged'
  | 'in_progress'
  | 'submitted'
  | 'returned'
  | 'completed'
  | 'cancelled';

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface Task {
  id: string;
  ref: string;                       // TSK-00001
  title: string;
  description: string;
  /** Required at assignment time. Without it, "completed" is contested. */
  definition_of_done: string;
  department_id: string;
  assignee_employee_id: string;
  assigner_employee_id: string | null;
  origin: TaskOrigin;
  /** self_initiated tasks only count toward metrics once a manager acknowledges. */
  origin_acknowledged_by: string | null;
  origin_acknowledged_at: string | null;
  recurrence_template_id: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  assigned_at: string | null;
  acknowledged_at: string | null;
  due_at: string | null;
  submitted_at: string | null;
  completed_at: string | null;
  returned_count: number;
  completion_note: string | null;
  evidence_urls: string[];
  created_at: string;
  updated_at: string;
}

/** Append-only. Never updated in place. This is what metrics are derived from. */
export interface TaskEvent {
  id: string;
  task_id: string;
  event_type:
    | 'created'
    | 'assigned'
    | 'acknowledged'
    | 'started'
    | 'submitted'
    | 'returned'
    | 'completed'
    | 'cancelled'
    | 'commented'
    | 'due_changed';
  actor_employee_id: string;
  at: string;
  from_status: TaskStatus | null;
  to_status: TaskStatus | null;
  note: string | null;
}
