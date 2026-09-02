-- 1. Configurable WIP limit on the cycle.
ALTER TABLE public.cc_call_cycles
  ADD COLUMN IF NOT EXISTS wip_limit integer NOT NULL DEFAULT 10;

ALTER TABLE public.cc_call_cycles
  DROP CONSTRAINT IF EXISTS cc_call_cycles_wip_limit_ck;

ALTER TABLE public.cc_call_cycles
  ADD CONSTRAINT cc_call_cycles_wip_limit_ck CHECK (wip_limit BETWEEN 1 AND 50);

UPDATE public.cc_call_cycles SET wip_limit = 10 WHERE wip_limit IS DISTINCT FROM 10;

-- 2. WIP guard reads the cycle's configured limit instead of a hardcoded 3.
CREATE OR REPLACE FUNCTION public.cc_attempt_before_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_open integer;
  v_attempts integer;
  v_cap integer;
  v_wip integer;
BEGIN
  SELECT r.attempts_made, c.attempt_cap, c.wip_limit
    INTO v_attempts, v_cap, v_wip
  FROM public.cc_cycle_rows r
  JOIN public.cc_call_cycles c ON c.id = r.cycle_id
  WHERE r.id = NEW.cycle_row_id
  FOR UPDATE OF r;

  IF v_attempts IS NULL THEN
    RAISE EXCEPTION 'Roster row % not found.', NEW.cycle_row_id;
  END IF;

  v_wip := COALESCE(v_wip, 10);

  SELECT count(*) INTO v_open
  FROM public.cc_call_attempts
  WHERE caller_id = NEW.caller_id AND recorded_at IS NULL;

  IF v_open >= v_wip THEN
    RAISE EXCEPTION
      'Record the outcome of your open calls before revealing another number. You may have % open at a time.',
      v_wip;
  END IF;

  NEW.attempt_no := v_attempts + 1;

  IF NEW.attempt_no > v_cap THEN
    RAISE EXCEPTION 'Attempt cap of % reached for this roster row.', v_cap;
  END IF;

  RETURN NEW;
END;
$function$;

-- 3. Engaged notes must satisfy the reporter_words minimum before insert.
CREATE OR REPLACE FUNCTION public.cc_record_engaged(p_attempt_id uuid, p_category_id uuid, p_severity hr_ticket_severity, p_note text, p_routed_to_staff_id uuid, p_consent boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  att public.cc_call_attempts;
  v_locked boolean;
  v_feedback_id uuid;
BEGIN
  att := public.cc_attempt_guard(p_attempt_id);

  IF p_note IS NULL OR btrim(p_note) = '' THEN
    RAISE EXCEPTION 'A note describing what the person said is required.';
  END IF;

  IF length(btrim(p_note)) < 20 THEN
    RAISE EXCEPTION 'Please write at least 20 characters describing what the customer said.';
  END IF;

  SELECT locked INTO v_locked FROM public.cc_feedback_categories WHERE id = p_category_id;
  IF v_locked IS NULL THEN
    RAISE EXCEPTION 'Unknown feedback category %.', p_category_id;
  END IF;

  UPDATE public.cc_call_attempts
  SET recorded_at = now(), outcome = 'engaged', channel = 'phone'
  WHERE id = p_attempt_id;

  INSERT INTO public.cc_feedback (attempt_id, category_id, severity, note, routed_to_actual, consent_to_contact)
  VALUES (
    p_attempt_id,
    p_category_id,
    p_severity,
    btrim(p_note),
    CASE WHEN v_locked THEN NULL ELSE p_routed_to_staff_id END,
    coalesce(p_consent,false)
  )
  RETURNING id INTO v_feedback_id;

  RETURN v_feedback_id;
END;
$function$;

-- 4. Feedback-raised tickets: internal origin, no reporter_contact, explicit length guards.
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

  IF v_dept IS NULL THEN
    RAISE EXCEPTION
      'Cannot raise ticket for feedback %: no department could be resolved (assignee %, creator %, required role %). Create the owning department first.',
      f.id, v_assignee, v_creator, v_required;
  END IF;

  -- A Welile operator raised this, not the customer: origin is internal and no
  -- reporter_contact is stored, because hr_tickets is read broadly across HR
  -- and exec surfaces. call_attempt_id keeps it identifiable as call centre.
  INSERT INTO public.hr_tickets (
    raised_by, raised_at, title, body, severity, severity_basis,
    surface_id, origin, reporter_channel, reported_at, reporter_words,
    call_attempt_id
  ) VALUES (
    att.caller_id, now(), v_title, f.note, f.severity,
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

-- 5. Park tickets: internal origin, no reporter_contact, explicit length guards.
CREATE OR REPLACE FUNCTION public.cc_raise_park_ticket(p_cycle_row_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  row_rec public.cc_cycle_rows;
  cat public.cc_feedback_categories;
  att public.cc_call_attempts;
  v_title text;
  v_body text;
  v_basis text := 'Call centre parked row';
  v_creator uuid;
  v_required public.app_role;
  v_dept uuid;
  v_task_id uuid;
  v_ticket_id uuid;
  v_existing uuid;
BEGIN
  SELECT * INTO row_rec FROM public.cc_cycle_rows WHERE id = p_cycle_row_id;
  IF row_rec.id IS NULL THEN
    RAISE EXCEPTION 'Cycle row % not found.', p_cycle_row_id;
  END IF;

  SELECT * INTO cat FROM public.cc_feedback_categories WHERE code = 'data_correction';
  IF cat.id IS NULL THEN
    RAISE EXCEPTION 'Feedback category data_correction is missing.';
  END IF;

  SELECT * INTO att
  FROM public.cc_call_attempts
  WHERE cycle_row_id = row_rec.id
  ORDER BY recorded_at DESC, id DESC
  LIMIT 1;

  IF att.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT t.id INTO v_existing
  FROM public.hr_tickets t
  JOIN public.cc_call_attempts a ON a.id = t.call_attempt_id
  WHERE a.cycle_row_id = row_rec.id
    AND t.severity_basis = v_basis
  ORDER BY t.raised_at ASC
  LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  v_title := 'Unreachable contact — ' || row_rec.subject_type::text;
  v_body := 'Parked after ' || row_rec.attempts_made || ' attempts. Reason: '
            || coalesce(row_rec.park_reason, 'unknown');

  IF length(btrim(coalesce(v_title, ''))) < 10 THEN
    RAISE EXCEPTION 'Ticket title is too short (minimum 10 characters): "%".', v_title;
  END IF;

  IF length(btrim(coalesce(v_body, ''))) < 20 THEN
    RAISE EXCEPTION 'Ticket description is too short (minimum 20 characters): "%".', v_body;
  END IF;

  SELECT s.id INTO v_creator FROM public.hr_staff s WHERE s.user_id = att.caller_id LIMIT 1;

  v_required := cat.default_owner_role;
  v_dept := public.cc_task_department(v_creator, v_required);

  -- Internal origin: the operator parked this row, the customer never contacted
  -- us. reporter_channel stays null because no conversation took place.
  INSERT INTO public.hr_tickets (
    raised_by, raised_at, title, body, severity, severity_basis,
    surface_id, origin, reporter_channel, reported_at, reporter_words,
    call_attempt_id
  ) VALUES (
    att.caller_id, now(), v_title, v_body, 'normal'::public.hr_ticket_severity,
    v_basis,
    cat.surface_id, 'internal'::public.hr_ticket_origin, NULL, att.recorded_at, v_body,
    att.id
  ) RETURNING id INTO v_ticket_id;

  INSERT INTO public.hr_tasks (
    title, description, department_id, assignee_staff_id, created_by_staff_id,
    priority, status, origin, due_at, required_role
  ) VALUES (
    v_title, v_body, v_dept, NULL, v_creator,
    'normal'::public.hr_task_priority, 'open'::public.hr_task_status, 'call_centre',
    now() + interval '7 days', v_required
  ) RETURNING id INTO v_task_id;

  UPDATE public.hr_tickets SET task_id = v_task_id WHERE id = v_ticket_id;

  RETURN v_ticket_id;
END;
$function$;