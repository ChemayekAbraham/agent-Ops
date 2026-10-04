CREATE OR REPLACE FUNCTION public.hr_apply_task_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
begin
  update public.hr_tasks t set
    status = case new.event_type
      when 'started'   then 'in_progress'::hr_task_status
      when 'blocked'   then 'blocked'::hr_task_status
      when 'unblocked' then 'in_progress'::hr_task_status
      when 'submitted' then 'submitted'::hr_task_status
      when 'completed' then 'completed'::hr_task_status
      when 'reopened'  then 'in_progress'::hr_task_status
      when 'cancelled' then 'cancelled'::hr_task_status
      when 'claimed'   then 'in_progress'::hr_task_status
      when 'returned'  then 'open'::hr_task_status
      else t.status end,
    started_at = case when new.event_type = 'started' and t.started_at is null
                      then new.occurred_at else t.started_at end,
    submitted_at = case when new.event_type = 'submitted'
                      then new.occurred_at else t.submitted_at end,
    completed_at = case when new.event_type = 'completed' then new.occurred_at
                        when new.event_type = 'reopened'  then null
                        else t.completed_at end,
    reopen_count = t.reopen_count + case when new.event_type = 'reopened' then 1 else 0 end,
    due_at = case when new.event_type = 'due_changed' and new.metadata ? 'due_at'
                  then (new.metadata->>'due_at')::timestamptz else t.due_at end,
    assignee_staff_id = case
      when new.event_type = 'returned' then null
      when new.event_type in ('assigned','claimed') and new.metadata ? 'assignee_staff_id'
        then (new.metadata->>'assignee_staff_id')::uuid
      else t.assignee_staff_id end
  where t.id = new.task_id;
  return new;
end $function$;

REVOKE SELECT, UPDATE ON SEQUENCE public.hr_staff_ref_seq FROM anon;
REVOKE SELECT, UPDATE ON SEQUENCE public.director_requisition_seq FROM anon;
REVOKE SELECT, UPDATE ON SEQUENCE public.login_phase_events_id_seq FROM anon;
REVOKE SELECT, UPDATE ON SEQUENCE public.agent_capability_ops_dead_letters_id_seq FROM anon;
REVOKE SELECT, UPDATE ON SEQUENCE public.agent_capability_ops_job_batches_id_seq FROM anon;
REVOKE SELECT, UPDATE ON SEQUENCE public.agent_capability_ops_undo_snapshots_id_seq FROM anon;