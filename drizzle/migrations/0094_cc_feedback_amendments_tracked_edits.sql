-- Tracked edits of call feedback. Additive only: no existing table, policy,
-- function or record is altered. cc_feedback keeps its row; every change to it
-- is written to an append-only amendment log first.

CREATE TABLE IF NOT EXISTS public.cc_feedback_amendments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id uuid NOT NULL REFERENCES public.cc_feedback(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES public.cc_call_attempts(id) ON DELETE CASCADE,
  edited_by uuid NOT NULL,
  edited_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL,
  old_category_id uuid,
  new_category_id uuid,
  old_severity hr_ticket_severity,
  new_severity hr_ticket_severity,
  old_note text,
  new_note text
);

CREATE INDEX IF NOT EXISTS cc_feedback_amendments_feedback_idx
  ON public.cc_feedback_amendments (feedback_id, edited_at DESC);
CREATE INDEX IF NOT EXISTS cc_feedback_amendments_attempt_idx
  ON public.cc_feedback_amendments (attempt_id, edited_at DESC);

GRANT SELECT ON public.cc_feedback_amendments TO authenticated;
GRANT ALL ON public.cc_feedback_amendments TO service_role;

ALTER TABLE public.cc_feedback_amendments ENABLE ROW LEVEL SECURITY;

-- Readable by whoever may already read the underlying call record. Never
-- writable from the client: only the SECURITY DEFINER amend function writes.
DROP POLICY IF EXISTS cc_feedback_amendments_read ON public.cc_feedback_amendments;
CREATE POLICY cc_feedback_amendments_read
ON public.cc_feedback_amendments
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.cc_call_attempts a
    JOIN public.cc_cycle_rows r ON r.id = a.cycle_row_id
    WHERE a.id = cc_feedback_amendments.attempt_id
      AND public.cc_can_read_subject(r.subject_type)
  )
);

-- Amend an existing feedback record. Records the before/after in
-- cc_feedback_amendments and audit_logs, then applies the change. Outcome,
-- routing, tickets, follow-ups and roster state are untouched.
CREATE OR REPLACE FUNCTION public.cc_amend_feedback(
  p_feedback_id uuid,
  p_category_id uuid,
  p_severity hr_ticket_severity,
  p_note text,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  fb public.cc_feedback;
  v_subject cc_subject_type;
  v_locked boolean;
  v_amendment_id uuid;
BEGIN
  SELECT * INTO fb FROM public.cc_feedback WHERE id = p_feedback_id;
  IF fb.id IS NULL THEN
    RAISE EXCEPTION 'Feedback record not found.';
  END IF;

  SELECT r.subject_type INTO v_subject
  FROM public.cc_call_attempts a
  JOIN public.cc_cycle_rows r ON r.id = a.cycle_row_id
  WHERE a.id = fb.attempt_id;

  IF v_subject IS NULL OR NOT public.cc_can_write_subject(v_subject) THEN
    RAISE EXCEPTION 'You are not allowed to edit this feedback.';
  END IF;

  IF p_note IS NULL OR length(btrim(p_note)) < 20 THEN
    RAISE EXCEPTION 'Please write at least 20 characters describing what the customer said.';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Please give a reason of at least 10 characters for this edit.';
  END IF;

  SELECT locked INTO v_locked FROM public.cc_feedback_categories WHERE id = p_category_id;
  IF v_locked IS NULL THEN
    RAISE EXCEPTION 'Unknown feedback category %.', p_category_id;
  END IF;

  IF fb.category_id = p_category_id
     AND fb.severity = p_severity
     AND btrim(fb.note) = btrim(p_note) THEN
    RAISE EXCEPTION 'Nothing was changed.';
  END IF;

  INSERT INTO public.cc_feedback_amendments (
    feedback_id, attempt_id, edited_by, reason,
    old_category_id, new_category_id,
    old_severity, new_severity,
    old_note, new_note
  ) VALUES (
    fb.id, fb.attempt_id, auth.uid(), btrim(p_reason),
    fb.category_id, p_category_id,
    fb.severity, p_severity,
    fb.note, btrim(p_note)
  )
  RETURNING id INTO v_amendment_id;

  UPDATE public.cc_feedback
  SET category_id = p_category_id,
      severity = p_severity,
      note = btrim(p_note)
  WHERE id = fb.id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, reason, metadata)
  VALUES (
    'cc_feedback_amended', 'cc_feedback', fb.id, auth.uid(), btrim(p_reason),
    jsonb_build_object(
      'amendment_id', v_amendment_id,
      'attempt_id', fb.attempt_id,
      'old_category_id', fb.category_id,
      'new_category_id', p_category_id,
      'old_severity', fb.severity,
      'new_severity', p_severity
    )
  );

  RETURN v_amendment_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.cc_amend_feedback(uuid, uuid, hr_ticket_severity, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_amend_feedback(uuid, uuid, hr_ticket_severity, text, text) TO authenticated;