CREATE OR REPLACE FUNCTION public.hr_task_wip_limit()
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 3;
$$;

CREATE OR REPLACE FUNCTION public.hr_task_wip_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_target uuid;
  v_count integer;
  v_limit integer;
  v_note text;
BEGIN
  IF NEW.event_type::text NOT IN ('assigned', 'claimed') THEN
    RETURN NEW;
  END IF;

  IF NEW.metadata IS NULL OR NOT (NEW.metadata ? 'assignee_staff_id') THEN
    RAISE EXCEPTION 'An assigned or claimed event must carry assignee_staff_id in metadata.';
  END IF;

  v_target := (NEW.metadata ->> 'assignee_staff_id')::uuid;

  SELECT count(*)
    INTO v_count
    FROM public.hr_tasks t
   WHERE t.assignee_staff_id = v_target
     AND t.status::text NOT IN ('completed', 'cancelled', 'blocked');

  v_limit := public.hr_task_wip_limit();

  IF v_count < v_limit THEN
    RETURN NEW;
  END IF;

  v_note := btrim(coalesce(NEW.note, ''));

  IF public.hr_can_assign_tasks() AND length(v_note) >= 10 THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Work-in-progress limit of % reached (found % open tasks). A person with assignment rights may exceed it by giving a written reason of at least 10 characters on the event.', v_limit, v_count;
END;
$$;

CREATE TRIGGER hr_task_events_wip_guard
BEFORE INSERT ON public.hr_task_events
FOR EACH ROW
EXECUTE FUNCTION public.hr_task_wip_guard();

CREATE OR REPLACE FUNCTION public.hr_task_freeze_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status::text NOT IN ('completed', 'cancelled') THEN
    RETURN NEW;
  END IF;

  IF NEW.ref IS DISTINCT FROM OLD.ref THEN
    RAISE EXCEPTION 'Task % is % and its column ref can no longer be changed.', OLD.ref, OLD.status;
  END IF;
  IF NEW.title IS DISTINCT FROM OLD.title THEN
    RAISE EXCEPTION 'Task % is % and its column title can no longer be changed.', OLD.ref, OLD.status;
  END IF;
  IF NEW.description IS DISTINCT FROM OLD.description THEN
    RAISE EXCEPTION 'Task % is % and its column description can no longer be changed.', OLD.ref, OLD.status;
  END IF;
  IF NEW.department_id IS DISTINCT FROM OLD.department_id THEN
    RAISE EXCEPTION 'Task % is % and its column department_id can no longer be changed.', OLD.ref, OLD.status;
  END IF;
  IF NEW.created_by_staff_id IS DISTINCT FROM OLD.created_by_staff_id THEN
    RAISE EXCEPTION 'Task % is % and its column created_by_staff_id can no longer be changed.', OLD.ref, OLD.status;
  END IF;
  IF NEW.origin IS DISTINCT FROM OLD.origin THEN
    RAISE EXCEPTION 'Task % is % and its column origin can no longer be changed.', OLD.ref, OLD.status;
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Task % is % and its column created_at can no longer be changed.', OLD.ref, OLD.status;
  END IF;
  IF NEW.priority IS DISTINCT FROM OLD.priority THEN
    RAISE EXCEPTION 'Task % is % and its column priority can no longer be changed.', OLD.ref, OLD.status;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER hr_tasks_freeze_guard
BEFORE UPDATE ON public.hr_tasks
FOR EACH ROW
EXECUTE FUNCTION public.hr_task_freeze_guard();

CREATE OR REPLACE FUNCTION public.hr_ticket_freeze_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.task_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.ref IS DISTINCT FROM OLD.ref THEN
    RAISE EXCEPTION 'Ticket % is claimed by a task and its column ref can no longer be changed.', OLD.ref;
  END IF;
  IF NEW.raised_by IS DISTINCT FROM OLD.raised_by THEN
    RAISE EXCEPTION 'Ticket % is claimed by a task and its column raised_by can no longer be changed.', OLD.ref;
  END IF;
  IF NEW.raised_at IS DISTINCT FROM OLD.raised_at THEN
    RAISE EXCEPTION 'Ticket % is claimed by a task and its column raised_at can no longer be changed.', OLD.ref;
  END IF;
  IF NEW.title IS DISTINCT FROM OLD.title THEN
    RAISE EXCEPTION 'Ticket % is claimed by a task and its column title can no longer be changed.', OLD.ref;
  END IF;
  IF NEW.body IS DISTINCT FROM OLD.body THEN
    RAISE EXCEPTION 'Ticket % is claimed by a task and its column body can no longer be changed.', OLD.ref;
  END IF;
  IF NEW.severity IS DISTINCT FROM OLD.severity THEN
    RAISE EXCEPTION 'Ticket % is claimed by a task and its column severity can no longer be changed.', OLD.ref;
  END IF;
  IF NEW.severity_basis IS DISTINCT FROM OLD.severity_basis THEN
    RAISE EXCEPTION 'Ticket % is claimed by a task and its column severity_basis can no longer be changed.', OLD.ref;
  END IF;
  IF NEW.surface_id IS DISTINCT FROM OLD.surface_id THEN
    RAISE EXCEPTION 'Ticket % is claimed by a task and its column surface_id can no longer be changed.', OLD.ref;
  END IF;
  IF NEW.origin IS DISTINCT FROM OLD.origin THEN
    RAISE EXCEPTION 'Ticket % is claimed by a task and its column origin can no longer be changed.', OLD.ref;
  END IF;
  IF NEW.reporter_name IS DISTINCT FROM OLD.reporter_name THEN
    RAISE EXCEPTION 'Ticket % is claimed by a task and its column reporter_name can no longer be changed.', OLD.ref;
  END IF;
  IF NEW.reporter_contact IS DISTINCT FROM OLD.reporter_contact THEN
    RAISE EXCEPTION 'Ticket % is claimed by a task and its column reporter_contact can no longer be changed.', OLD.ref;
  END IF;
  IF NEW.reporter_channel IS DISTINCT FROM OLD.reporter_channel THEN
    RAISE EXCEPTION 'Ticket % is claimed by a task and its column reporter_channel can no longer be changed.', OLD.ref;
  END IF;
  IF NEW.reported_at IS DISTINCT FROM OLD.reported_at THEN
    RAISE EXCEPTION 'Ticket % is claimed by a task and its column reported_at can no longer be changed.', OLD.ref;
  END IF;
  IF NEW.reporter_words IS DISTINCT FROM OLD.reporter_words THEN
    RAISE EXCEPTION 'Ticket % is claimed by a task and its column reporter_words can no longer be changed.', OLD.ref;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER hr_tickets_freeze_guard
BEFORE UPDATE ON public.hr_tickets
FOR EACH ROW
EXECUTE FUNCTION public.hr_ticket_freeze_guard();