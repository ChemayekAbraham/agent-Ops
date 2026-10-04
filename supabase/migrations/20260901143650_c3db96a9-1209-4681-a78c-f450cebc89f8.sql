CREATE OR REPLACE FUNCTION public.cc_raise_from_feedback(p_feedback_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  f public.cc_feedback;
  cat public.cc_feedback_categories;
  att public.cc_call_attempts;
  row_rec public.cc_cycle_rows;
  v_title text;
  v_priority public.hr_task_priority;
  v_due timestamptz;
  v_creator uuid;
  v_assignee uuid;
  v_required public.app_role;
  v_dept uuid;
  v_task_id uuid;
  v_ticket_id uuid;
  v_check uuid;
BEGIN
  SELECT * INTO f FROM public.cc_feedback WHERE id = p_feedback_id;
  IF f.id IS NULL THEN
    RAISE EXCEPTION 'Feedback % not found.', p_feedback_id;
  END IF;

  SELECT * INTO cat FROM public.cc_feedback_categories WHERE id = f.category_id;
  IF cat.id IS NULL THEN
    RAISE EXCEPTION 'Unknown feedback category % on feedback %.', f.category_id, f.id;
  END IF;

  SELECT * INTO att FROM public.cc_call_attempts WHERE id = f.attempt_id;
  IF att.id IS NULL THEN
    RAISE EXCEPTION 'Feedback % has no call attempt %.', f.id, f.attempt_id;
  END IF;

  SELECT * INTO row_rec FROM public.cc_cycle_rows WHERE id = att.cycle_row_id;

  IF NOT cat.raises_ticket THEN
    RETURN NULL;
  END IF;

  -- Already raised: keep idempotent, never duplicate a ticket.
  IF f.ticket_id IS NOT NULL THEN
    RETURN f.ticket_id;
  END IF;

  v_title := cat.label || ' — ' || COALESCE(row_rec.subject_type::text, 'unknown subject');

  v_priority := CASE f.severity
    WHEN 'critical' THEN 'urgent'::public.hr_task_priority
    WHEN 'high'     THEN 'high'::public.hr_task_priority
    ELSE 'normal'::public.hr_task_priority
  END;

  v_due := now() + CASE f.severity
    WHEN 'critical' THEN interval '1 day'
    WHEN 'high'     THEN interval '3 days'
    ELSE interval '7 days'
  END;

  SELECT s.id INTO v_creator FROM public.hr_staff s WHERE s.user_id = att.caller_id LIMIT 1;

  IF cat.locked THEN
    v_assignee := NULL;
    v_required := cat.default_owner_role;
  ELSIF f.routed_to_actual IS NOT NULL THEN
    v_assignee := f.routed_to_actual;
    v_required := NULL;
  ELSE
    v_assignee := NULL;
    v_required := cat.default_owner_role;
  END IF;

  v_dept := public.cc_task_department(COALESCE(v_assignee, v_creator), v_required);

  -- hr_tasks.department_id is NOT NULL: fail with a readable cause, never a bare constraint error.
  IF v_dept IS NULL THEN
    RAISE EXCEPTION
      'Cannot raise ticket for feedback %: no department could be resolved (assignee %, creator %, required role %). Create the owning department first.',
      f.id, v_assignee, v_creator, v_required;
  END IF;

  INSERT INTO public.hr_tickets (
    raised_by, raised_at, title, body, severity, severity_basis,
    surface_id, origin, reporter_channel, reported_at, reporter_words,
    call_attempt_id
  ) VALUES (
    att.caller_id, now(), v_title, f.note, f.severity,
    'Call centre feedback, category ' || cat.code,
    cat.surface_id, 'external'::public.hr_ticket_origin, att.channel, att.recorded_at, f.note,
    att.id
  ) RETURNING id INTO v_ticket_id;

  INSERT INTO public.hr_tasks (
    title, description, department_id, assignee_staff_id, created_by_staff_id,
    priority, status, origin, due_at, required_role
  ) VALUES (
    v_title, f.note, v_dept, v_assignee, v_creator,
    v_priority, 'open'::public.hr_task_status, 'call_centre', v_due, v_required
  ) RETURNING id INTO v_task_id;

  UPDATE public.hr_tickets SET task_id = v_task_id WHERE id = v_ticket_id;
  UPDATE public.cc_feedback SET ticket_id = v_ticket_id WHERE id = f.id;

  -- Post-condition guard: a raising category MUST end up linked to a ticket
  -- that itself is linked to a task. Anything else aborts the whole save.
  SELECT ticket_id INTO v_check FROM public.cc_feedback WHERE id = f.id;
  IF v_check IS NULL OR v_check <> v_ticket_id THEN
    RAISE EXCEPTION
      'Ticket routing failed for feedback % (category %): cc_feedback.ticket_id was not linked.',
      f.id, cat.code;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.hr_tickets t
    WHERE t.id = v_ticket_id AND t.task_id = v_task_id AND t.call_attempt_id = att.id
  ) THEN
    RAISE EXCEPTION
      'Ticket routing failed for feedback % (category %): ticket % is not linked to task %.',
      f.id, cat.code, v_ticket_id, v_task_id;
  END IF;

  RETURN v_ticket_id;
END;
$function$;

-- The AFTER INSERT trigger must never swallow an error: no exception handler,
-- so a failed ticket creation aborts the feedback insert with it.
CREATE OR REPLACE FUNCTION public.cc_feedback_after_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_raises boolean;
  v_ticket uuid;
BEGIN
  PERFORM public.cc_raise_from_feedback(NEW.id);

  SELECT c.raises_ticket INTO v_raises
  FROM public.cc_feedback_categories c WHERE c.id = NEW.category_id;

  IF COALESCE(v_raises, false) THEN
    SELECT ticket_id INTO v_ticket FROM public.cc_feedback WHERE id = NEW.id;
    IF v_ticket IS NULL THEN
      RAISE EXCEPTION
        'Feedback % requires a ticket but none was created — refusing to save silently.', NEW.id;
    END IF;
  END IF;

  RETURN NULL;
END;
$function$;

-- Backfill: repair every orphan whose category should have raised a ticket.
DO $backfill$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT f.id
    FROM public.cc_feedback f
    JOIN public.cc_feedback_categories c ON c.id = f.category_id
    WHERE c.raises_ticket AND f.ticket_id IS NULL
    ORDER BY f.created_at
  LOOP
    PERFORM public.cc_raise_from_feedback(r.id);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'cc_raise_from_feedback backfill repaired % feedback rows', n;
END
$backfill$;