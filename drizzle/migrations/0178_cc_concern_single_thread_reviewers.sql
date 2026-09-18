-- One concern per call, many reviewers.
-- Forwarding the same source call again no longer creates a second concern:
-- it adds another reviewer to the single existing concern and records an event.

CREATE TABLE IF NOT EXISTS public.cc_concern_reviewers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concern_id uuid NOT NULL REFERENCES public.cc_forwarded_concerns(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  staff_id uuid,
  full_name text,
  role text NOT NULL DEFAULT 'reviewer',
  added_by uuid,
  added_by_name text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cc_concern_reviewers_role_ck CHECK (role IN ('handler','reviewer')),
  CONSTRAINT cc_concern_reviewers_unique UNIQUE (concern_id, user_id)
);

GRANT SELECT ON public.cc_concern_reviewers TO authenticated;
GRANT ALL ON public.cc_concern_reviewers TO service_role;

ALTER TABLE public.cc_concern_reviewers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cc_reviewers_select_scoped ON public.cc_concern_reviewers;
CREATE POLICY cc_reviewers_select_scoped ON public.cc_concern_reviewers
FOR SELECT TO authenticated
USING (
  user_id = auth.uid()
  OR added_by = auth.uid()
  OR has_role(auth.uid(), 'hr')
  OR has_role(auth.uid(), 'ceo')
  OR has_role(auth.uid(), 'coo')
  OR has_role(auth.uid(), 'tenant_ops')
  OR has_role(auth.uid(), 'manager')
  OR has_role(auth.uid(), 'super_admin')
);

CREATE INDEX IF NOT EXISTS cc_concern_reviewers_concern_idx ON public.cc_concern_reviewers (concern_id);
CREATE INDEX IF NOT EXISTS cc_concern_reviewers_user_idx ON public.cc_concern_reviewers (user_id);

-- Backfill: every current handler is a reviewer of their own concern.
INSERT INTO public.cc_concern_reviewers (concern_id, user_id, staff_id, full_name, role, added_by, added_by_name, created_at)
SELECT c.id, c.forwarded_to, c.forwarded_to_staff_id, c.forwarded_to_name, 'handler', c.forwarded_by, c.forwarded_by_name, c.created_at
  FROM public.cc_forwarded_concerns c
 WHERE c.forwarded_to IS NOT NULL
ON CONFLICT (concern_id, user_id) DO NOTHING;

-- Allow the new audit action.
ALTER TABLE public.cc_forwarded_concern_events DROP CONSTRAINT IF EXISTS cc_fce_action_ck;
ALTER TABLE public.cc_forwarded_concern_events ADD CONSTRAINT cc_fce_action_ck
  CHECK (action = ANY (ARRAY['forwarded','accepted','started','progress_note','completed','reassigned','due_changed','reviewer_added']));

-- Reviewers keep sight of the concern.
DROP POLICY IF EXISTS cc_fc_select_scoped ON public.cc_forwarded_concerns;
CREATE POLICY cc_fc_select_scoped ON public.cc_forwarded_concerns
FOR SELECT TO authenticated
USING (
  forwarded_to = auth.uid()
  OR forwarded_by = auth.uid()
  OR original_forwarded_to = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.cc_concern_reviewers r
     WHERE r.concern_id = cc_forwarded_concerns.id AND r.user_id = auth.uid()
  )
  OR has_role(auth.uid(), 'hr')
  OR has_role(auth.uid(), 'ceo')
  OR has_role(auth.uid(), 'coo')
  OR has_role(auth.uid(), 'tenant_ops')
  OR has_role(auth.uid(), 'manager')
  OR has_role(auth.uid(), 'super_admin')
);

-- Add another reviewer to an existing concern (append-only, fully audited).
CREATE OR REPLACE FUNCTION public.cc_add_concern_reviewer(
  p_concern_id uuid,
  p_user_id uuid,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.cc_forwarded_concerns;
  v_by text;
  v_to text;
  v_staff uuid;
  v_existing uuid;
BEGIN
  IF v_uid IS NULL OR NOT (is_welile_staff(v_uid) OR has_role(v_uid, 'super_admin')) THEN
    RAISE EXCEPTION 'Only Welile staff can add a reviewer.';
  END IF;

  SELECT * INTO v_row FROM public.cc_forwarded_concerns WHERE id = p_concern_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Concern not found.';
  END IF;

  SELECT o.full_name, o.staff_id INTO v_to, v_staff
    FROM public.cc_forward_staff_options() o
   WHERE o.user_id = p_user_id;
  IF v_to IS NULL THEN
    RAISE EXCEPTION 'That person cannot receive concerns. Choose a staff member with an active employee role.';
  END IF;

  SELECT id INTO v_existing FROM public.cc_concern_reviewers
   WHERE concern_id = p_concern_id AND user_id = p_user_id;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'already_present', true, 'reviewer_name', v_to);
  END IF;

  SELECT coalesce(nullif(btrim(full_name), ''), 'Officer') INTO v_by FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.cc_concern_reviewers (concern_id, user_id, staff_id, full_name, role, added_by, added_by_name, note)
  VALUES (p_concern_id, p_user_id, v_staff, v_to, 'reviewer', v_uid, v_by, nullif(btrim(coalesce(p_note,'')), ''));

  INSERT INTO public.cc_forwarded_concern_events (concern_id, action, actor_id, actor_name, note, new_user_id, new_user_name, reason)
  VALUES (p_concern_id, 'reviewer_added', v_uid, v_by, nullif(btrim(coalesce(p_note,'')), ''), p_user_id, v_to, nullif(btrim(coalesce(p_note,'')), ''));

  UPDATE public.cc_forwarded_concerns SET updated_at = now() WHERE id = p_concern_id;

  RETURN jsonb_build_object('success', true, 'already_present', false, 'reviewer_name', v_to);
END $$;

GRANT EXECUTE ON FUNCTION public.cc_add_concern_reviewer(uuid, uuid, text) TO authenticated;

-- Forwarding is now idempotent per source call: the second and later hand-offs
-- add a reviewer to the single concern instead of creating a duplicate.
CREATE OR REPLACE FUNCTION public.cc_forward_concern(
  p_source_kind text,
  p_title text,
  p_forwarded_to uuid,
  p_context text DEFAULT NULL,
  p_priority text DEFAULT 'normal',
  p_feedback_id uuid DEFAULT NULL,
  p_received_call_id uuid DEFAULT NULL,
  p_cycle_row_id uuid DEFAULT NULL,
  p_caller_name text DEFAULT NULL,
  p_caller_user_id uuid DEFAULT NULL,
  p_subject_type text DEFAULT NULL,
  p_due_hours integer DEFAULT 24
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
  v_by text;
  v_to text;
  v_staff uuid;
  v_hours integer;
BEGIN
  IF v_uid IS NULL OR NOT (is_welile_staff(v_uid) OR has_role(v_uid, 'super_admin')) THEN
    RAISE EXCEPTION 'Only Welile staff can forward a concern.';
  END IF;
  IF p_source_kind NOT IN ('outbound_call','received_call') THEN
    RAISE EXCEPTION 'Unknown call source.';
  END IF;
  IF length(btrim(coalesce(p_title,''))) < 5 THEN
    RAISE EXCEPTION 'Give the concern a short title (at least 5 characters).';
  END IF;

  SELECT o.full_name, o.staff_id INTO v_to, v_staff
    FROM public.cc_forward_staff_options() o
   WHERE o.user_id = p_forwarded_to;
  IF v_to IS NULL THEN
    RAISE EXCEPTION 'That person cannot receive concerns. Choose a staff member with an active employee role.';
  END IF;

  -- One concern per source call.
  SELECT c.id INTO v_id
    FROM public.cc_forwarded_concerns c
   WHERE (p_received_call_id IS NOT NULL AND c.received_call_id = p_received_call_id)
      OR (p_received_call_id IS NULL AND p_feedback_id IS NOT NULL AND c.feedback_id = p_feedback_id)
      OR (p_received_call_id IS NULL AND p_feedback_id IS NULL AND p_cycle_row_id IS NOT NULL AND c.cycle_row_id = p_cycle_row_id)
   ORDER BY c.created_at ASC
   LIMIT 1;

  IF v_id IS NOT NULL THEN
    PERFORM public.cc_add_concern_reviewer(v_id, p_forwarded_to, NULL);
    RETURN v_id;
  END IF;

  SELECT coalesce(nullif(btrim(full_name), ''), 'Officer') INTO v_by FROM public.profiles WHERE id = v_uid;

  v_hours := greatest(1, least(168, coalesce(p_due_hours, 24)));

  INSERT INTO public.cc_forwarded_concerns (
    source_kind, feedback_id, received_call_id, cycle_row_id, caller_name, caller_user_id,
    subject_type, title, context, priority, forwarded_by, forwarded_by_name,
    forwarded_to, forwarded_to_staff_id, forwarded_to_name, status, due_at,
    original_forwarded_to, original_forwarded_to_name, due_is_custom
  ) VALUES (
    p_source_kind, p_feedback_id, p_received_call_id, p_cycle_row_id,
    nullif(btrim(coalesce(p_caller_name,'')), ''), p_caller_user_id,
    nullif(btrim(coalesce(p_subject_type,'')), ''), btrim(p_title),
    nullif(btrim(coalesce(p_context,'')), ''), coalesce(nullif(btrim(coalesce(p_priority,'')), ''), 'normal'),
    v_uid, v_by, p_forwarded_to, v_staff, v_to, 'sent', now() + make_interval(hours => v_hours),
    p_forwarded_to, v_to, (p_due_hours IS NOT NULL AND p_due_hours <> 24)
  ) RETURNING id INTO v_id;

  INSERT INTO public.cc_forwarded_concern_events (concern_id, action, actor_id, actor_name, note, new_user_id, new_user_name)
  VALUES (v_id, 'forwarded', v_uid, v_by, nullif(btrim(coalesce(p_context,'')), ''), p_forwarded_to, v_to);

  INSERT INTO public.cc_concern_reviewers (concern_id, user_id, staff_id, full_name, role, added_by, added_by_name)
  VALUES (v_id, p_forwarded_to, v_staff, v_to, 'handler', v_uid, v_by)
  ON CONFLICT (concern_id, user_id) DO NOTHING;

  RETURN v_id;
END $$;

-- Reviewers may add progress notes on the shared concern.
CREATE OR REPLACE FUNCTION public.cc_concern_event(
  p_concern_id uuid,
  p_action text,
  p_note text DEFAULT NULL,
  p_follow_up_needed boolean DEFAULT NULL,
  p_follow_up_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.cc_forwarded_concerns;
  v_name text;
  v_is_reviewer boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Please sign in again.';
  END IF;
  IF p_action NOT IN ('accepted','started','progress_note','completed') THEN
    RAISE EXCEPTION 'Unknown step.';
  END IF;

  SELECT * INTO v_row FROM public.cc_forwarded_concerns WHERE id = p_concern_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Concern not found.';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.cc_concern_reviewers r
     WHERE r.concern_id = p_concern_id AND r.user_id = v_uid
  ) INTO v_is_reviewer;

  IF p_action IN ('accepted','started','completed') AND v_row.forwarded_to <> v_uid AND NOT v_is_reviewer THEN
    RAISE EXCEPTION 'Only the people this concern was sent to can move it along.';
  END IF;
  IF p_action = 'progress_note' AND v_uid NOT IN (v_row.forwarded_to, v_row.forwarded_by) AND NOT v_is_reviewer THEN
    RAISE EXCEPTION 'Only the sender or the people handling it can add a note.';
  END IF;
  IF v_row.status = 'completed' THEN
    RAISE EXCEPTION 'This concern is already completed.';
  END IF;
  IF p_action = 'completed' AND length(btrim(coalesce(p_note,''))) < 10 THEN
    RAISE EXCEPTION 'Write what was done to resolve it (at least 10 characters).';
  END IF;

  SELECT coalesce(nullif(btrim(full_name), ''), 'Staff member') INTO v_name FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.cc_forwarded_concern_events (concern_id, action, actor_id, actor_name, note)
  VALUES (p_concern_id, p_action, v_uid, v_name, nullif(btrim(coalesce(p_note,'')), ''));

  IF p_follow_up_needed IS NOT NULL OR p_follow_up_note IS NOT NULL THEN
    UPDATE public.cc_forwarded_concerns
       SET follow_up_needed = coalesce(p_follow_up_needed, follow_up_needed),
           follow_up_note = coalesce(nullif(btrim(coalesce(p_follow_up_note,'')), ''), follow_up_note),
           updated_at = now()
     WHERE id = p_concern_id;
  END IF;

  SELECT * INTO v_row FROM public.cc_forwarded_concerns WHERE id = p_concern_id;
  RETURN jsonb_build_object('success', true, 'status', v_row.status);
END $$;

-- Reviewers list for a concern (readable by anyone who can see the concern).
CREATE OR REPLACE FUNCTION public.cc_concern_reviewer_list(p_concern_ids uuid[])
RETURNS TABLE (concern_id uuid, user_id uuid, full_name text, role text, added_by_name text, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT r.concern_id, r.user_id, r.full_name, r.role, r.added_by_name, r.created_at
    FROM public.cc_concern_reviewers r
   WHERE r.concern_id = ANY (p_concern_ids)
     AND (
       auth.uid() IS NOT NULL
       AND (
         is_welile_staff(auth.uid())
         OR has_role(auth.uid(), 'super_admin')
         OR r.user_id = auth.uid()
       )
     )
   ORDER BY r.created_at ASC;
$$;

GRANT EXECUTE ON FUNCTION public.cc_concern_reviewer_list(uuid[]) TO authenticated;