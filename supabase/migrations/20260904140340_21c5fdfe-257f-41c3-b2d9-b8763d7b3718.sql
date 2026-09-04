CREATE OR REPLACE FUNCTION public.cc_raise_from_feedback(p_feedback_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  f public.cc_feedback;
  cat public.cc_feedback_categories;
  att public.cc_call_attempts;
  row_rec public.cc_cycle_rows;
  v_title text;
  v_basis text;
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

  IF f.ticket_id IS NOT NULL THEN
    RETURN f.ticket_id;
  END IF;

  v_title := cat.label || ' — ' || COALESCE(row_rec.subject_type::text, 'unknown subject');
  v_basis := 'Call centre feedback, category ' || cat.code;

  IF length(btrim(coalesce(v_title, ''))) < 10 THEN
    RAISE EXCEPTION 'Ticket title is too short (minimum 10 characters): "%".', v_title;
  END IF;

  IF length(btrim(coalesce(f.note, ''))) < 20 THEN
    RAISE EXCEPTION 'Please write at least 20 characters describing what the customer said.';
  END IF;

  IF f.severity = 'critical' AND length(btrim(coalesce(v_basis, ''))) < 10 THEN
    RAISE EXCEPTION 'Severity basis is too short for a critical ticket (minimum 10 characters): "%".', v_basis;
  END IF;

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

  v_dept := public.cc_task_department(COALESCE(v_assignee, NULL), v_required);

  -- hr_tickets.raised_by and hr_tasks.created_by_staff_id both reference
  -- hr_staff(id), never auth.users(id). Resolve the staff record for the caller.
  SELECT s.id INTO v_creator
  FROM public.hr_staff s
  WHERE s.user_id = att.caller_id AND s.active
  LIMIT 1;

  -- Callers are not always staff members (field/ops callers frequently are not).
  -- Rather than refusing to save the feedback, raise the ticket on behalf of the
  -- responsible owner: the chosen assignee, the expected owner for the category,
  -- or any active member of the owning department.
  IF v_creator IS NULL THEN
    v_creator := f.routed_to_actual;
  END IF;

  IF v_creator IS NULL THEN
    v_creator := f.routed_to_expected;
  END IF;

  IF v_creator IS NULL THEN
    v_creator := public.cc_expected_owner_staff(cat.default_owner_role);
  END IF;

  IF v_creator IS NULL AND v_dept IS NOT NULL THEN
    SELECT s.id INTO v_creator
    FROM public.hr_staff s
    JOIN public.hr_assignments a ON a.staff_id = s.id AND a.ended_on IS NULL
    WHERE s.active AND a.department_id = v_dept
    ORDER BY a.is_primary DESC NULLS LAST, a.started_on DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_creator IS NULL THEN
    RAISE EXCEPTION 'No responsible staff member could be resolved for this feedback, so a ticket cannot be raised. Set an owner for the % department first.', COALESCE(v_required::text, 'owning');
  END IF;

  IF v_dept IS NULL THEN
    v_dept := public.cc_task_department(COALESCE(v_assignee, v_creator), v_required);
  END IF;

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
    v_creator, now(), v_title, f.note, f.severity,
    v_basis,
    cat.surface_id, 'internal'::public.hr_ticket_origin, att.channel, att.recorded_at, f.note,
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