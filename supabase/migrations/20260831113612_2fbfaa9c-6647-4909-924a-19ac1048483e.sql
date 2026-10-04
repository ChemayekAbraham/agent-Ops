-- 1. cc_followups
CREATE TABLE public.cc_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NULL REFERENCES public.hr_tickets(id) ON DELETE SET NULL,
  cycle_row_id uuid NULL REFERENCES public.cc_cycle_rows(id) ON DELETE SET NULL,
  subject_type public.cc_subject_type NOT NULL,
  subject_id uuid NOT NULL,
  owed_by_staff_id uuid NULL REFERENCES public.hr_staff(id),
  reason text NOT NULL,
  due_at timestamptz NOT NULL,
  completed_at timestamptz NULL,
  completed_by uuid NULL REFERENCES public.hr_staff(id),
  completion_note text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_cc_followups_owner_open ON public.cc_followups (owed_by_staff_id, completed_at);
CREATE INDEX idx_cc_followups_due_open ON public.cc_followups (due_at) WHERE completed_at IS NULL;
CREATE INDEX idx_cc_followups_ticket ON public.cc_followups (ticket_id);

GRANT SELECT, INSERT, UPDATE ON public.cc_followups TO authenticated;
GRANT ALL ON public.cc_followups TO service_role;

ALTER TABLE public.cc_followups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cc_followups_read_scoped"
ON public.cc_followups FOR SELECT TO authenticated
USING (public.cc_can_read_subject(subject_type));

CREATE POLICY "cc_followups_insert_scoped"
ON public.cc_followups FOR INSERT TO authenticated
WITH CHECK (public.cc_can_write_subject(subject_type));

CREATE POLICY "cc_followups_update_scoped"
ON public.cc_followups FOR UPDATE TO authenticated
USING (public.cc_can_write_subject(subject_type))
WITH CHECK (public.cc_can_write_subject(subject_type));

-- 2. cc_raise_park_ticket
CREATE OR REPLACE FUNCTION public.cc_raise_park_ticket(p_cycle_row_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  row_rec public.cc_cycle_rows;
  cat public.cc_feedback_categories;
  att public.cc_call_attempts;
  v_title text;
  v_body text;
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

  -- No attempt means no caller to attribute the ticket to; nothing to raise.
  IF att.id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Idempotent: one park ticket per cycle row.
  SELECT t.id INTO v_existing
  FROM public.hr_tickets t
  JOIN public.cc_call_attempts a ON a.id = t.call_attempt_id
  WHERE a.cycle_row_id = row_rec.id
    AND t.severity_basis = 'Call centre parked row'
  ORDER BY t.raised_at ASC
  LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  v_title := 'Unreachable contact — ' || row_rec.subject_type::text;
  v_body := 'Parked after ' || row_rec.attempts_made || ' attempts. Reason: '
            || coalesce(row_rec.park_reason, 'unknown');

  SELECT s.id INTO v_creator FROM public.hr_staff s WHERE s.user_id = att.caller_id LIMIT 1;

  v_required := cat.default_owner_role;
  v_dept := public.cc_task_department(v_creator, v_required);

  INSERT INTO public.hr_tickets (
    raised_by, raised_at, title, body, severity, severity_basis,
    surface_id, origin, reporter_channel, reported_at, reporter_words,
    call_attempt_id
  ) VALUES (
    att.caller_id, now(), v_title, v_body, 'normal'::public.hr_ticket_severity,
    'Call centre parked row',
    cat.surface_id, 'external'::public.hr_ticket_origin, NULL, att.recorded_at, v_body,
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

REVOKE EXECUTE ON FUNCTION public.cc_raise_park_ticket(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_raise_park_ticket(uuid) TO authenticated;

-- 3. Park trigger
CREATE OR REPLACE FUNCTION public.cc_park_raise_ticket_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF NEW.state = 'parked' AND COALESCE(OLD.state::text, '') <> 'parked' THEN
    PERFORM public.cc_raise_park_ticket(NEW.id);
  END IF;
  RETURN NULL;
END;
$function$;

CREATE TRIGGER trg_cc_cycle_rows_park_ticket
AFTER UPDATE OF state ON public.cc_cycle_rows
FOR EACH ROW EXECUTE FUNCTION public.cc_park_raise_ticket_trg();

-- 4. Promise loop
CREATE OR REPLACE FUNCTION public.cc_task_completed_followup_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  tkt public.hr_tickets;
  att public.cc_call_attempts;
  row_rec public.cc_cycle_rows;
  v_owed uuid;
BEGIN
  IF NEW.status::text <> 'completed'
     OR COALESCE(OLD.status::text, '') = 'completed'
     OR COALESCE(NEW.origin, '') <> 'call_centre' THEN
    RETURN NULL;
  END IF;

  SELECT * INTO tkt FROM public.hr_tickets WHERE task_id = NEW.id ORDER BY raised_at ASC LIMIT 1;
  IF tkt.id IS NULL OR tkt.call_attempt_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.cc_followups
    WHERE ticket_id = tkt.id AND completed_at IS NULL
  ) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO att FROM public.cc_call_attempts WHERE id = tkt.call_attempt_id;
  IF att.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO row_rec FROM public.cc_cycle_rows WHERE id = att.cycle_row_id;
  IF row_rec.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT s.id INTO v_owed FROM public.hr_staff s WHERE s.user_id = att.caller_id LIMIT 1;

  INSERT INTO public.cc_followups (
    ticket_id, cycle_row_id, subject_type, subject_id,
    owed_by_staff_id, reason, due_at
  ) VALUES (
    tkt.id, row_rec.id, row_rec.subject_type, row_rec.subject_id,
    v_owed, 'Close the promise made on the original call', now() + interval '2 days'
  );

  RETURN NULL;
END;
$function$;

CREATE TRIGGER trg_hr_tasks_cc_followup
AFTER UPDATE OF status ON public.hr_tasks
FOR EACH ROW EXECUTE FUNCTION public.cc_task_completed_followup_trg();

-- 5. cc_complete_followup
CREATE OR REPLACE FUNCTION public.cc_complete_followup(p_followup_id uuid, p_note text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  f public.cc_followups;
  v_staff uuid;
BEGIN
  SELECT * INTO f FROM public.cc_followups WHERE id = p_followup_id;
  IF f.id IS NULL THEN
    RAISE EXCEPTION 'Follow-up % not found.', p_followup_id;
  END IF;
  IF f.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Follow-up % is already closed.', p_followup_id;
  END IF;

  SELECT s.id INTO v_staff FROM public.hr_staff s WHERE s.user_id = auth.uid() LIMIT 1;

  IF NOT (
    (v_staff IS NOT NULL AND f.owed_by_staff_id = v_staff)
    OR public.has_role(auth.uid(), 'operations')
    OR public.has_role(auth.uid(), 'hr')
    OR public.has_role(auth.uid(), 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Not authorized to close this follow-up.';
  END IF;

  UPDATE public.cc_followups
  SET completed_at = now(),
      completed_by = v_staff,
      completion_note = p_note
  WHERE id = p_followup_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cc_complete_followup(uuid, text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_complete_followup(uuid, text) TO authenticated;