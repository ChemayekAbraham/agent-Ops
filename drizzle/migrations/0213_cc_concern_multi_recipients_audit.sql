-- Calling Center concerns: multiple recipients, add/remove at any stage, full audit trail.

ALTER TABLE public.cc_concern_reviewers
  ADD COLUMN IF NOT EXISTS notified_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS added_reason text,
  ADD COLUMN IF NOT EXISTS removed_at timestamptz,
  ADD COLUMN IF NOT EXISTS removed_by uuid,
  ADD COLUMN IF NOT EXISTS removed_by_name text,
  ADD COLUMN IF NOT EXISTS remove_reason text;

ALTER TABLE public.cc_forwarded_concern_events
  ADD COLUMN IF NOT EXISTS prev_recipients text,
  ADD COLUMN IF NOT EXISTS new_recipients text;

ALTER TABLE public.cc_forwarded_concern_events DROP CONSTRAINT IF EXISTS cc_fce_action_ck;
ALTER TABLE public.cc_forwarded_concern_events
  ADD CONSTRAINT cc_fce_action_ck CHECK (action = ANY (ARRAY[
    'forwarded','accepted','started','progress_note','completed',
    'reassigned','due_changed','reviewer_added','reviewer_removed'
  ]));

CREATE INDEX IF NOT EXISTS cc_concern_reviewers_active_idx
  ON public.cc_concern_reviewers (concern_id) WHERE removed_at IS NULL;

-- Current participant list as plain text, for the audit trail snapshots.
CREATE OR REPLACE FUNCTION public.cc_concern_participants_text(p_concern_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT coalesce(string_agg(r.full_name, ', ' ORDER BY r.created_at), '')
    FROM public.cc_concern_reviewers r
   WHERE r.concern_id = p_concern_id
     AND r.removed_at IS NULL;
$$;

-- Who may add or remove people: the sender, any current participant, HR, the CEO.
CREATE OR REPLACE FUNCTION public.cc_can_manage_concern_participants(
  p_concern_id uuid, p_user_id uuid DEFAULT auth.uid()
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT p_user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.cc_forwarded_concerns c
     WHERE c.id = p_concern_id
       AND (
         c.forwarded_by = p_user_id
         OR c.forwarded_to = p_user_id
         OR EXISTS (
           SELECT 1 FROM public.cc_concern_reviewers r
            WHERE r.concern_id = c.id AND r.user_id = p_user_id AND r.removed_at IS NULL
         )
         OR public.has_role(p_user_id, 'hr'::public.app_role)
         OR public.has_role(p_user_id, 'ceo'::public.app_role)
         OR public.has_role(p_user_id, 'super_admin'::public.app_role)
       )
  );
$$;

CREATE OR REPLACE FUNCTION public.cc_add_concern_reviewer(
  p_concern_id uuid, p_user_id uuid, p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.cc_forwarded_concerns;
  v_by text;
  v_to text;
  v_staff uuid;
  v_existing public.cc_concern_reviewers;
  v_prev text;
  v_new text;
BEGIN
  IF v_uid IS NULL OR NOT (is_welile_staff(v_uid) OR has_role(v_uid, 'super_admin')) THEN
    RAISE EXCEPTION 'Only Welile staff can add a reviewer.';
  END IF;

  SELECT * INTO v_row FROM public.cc_forwarded_concerns WHERE id = p_concern_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Concern not found.';
  END IF;

  IF NOT public.cc_can_manage_concern_participants(p_concern_id, v_uid) THEN
    RAISE EXCEPTION 'Only the sender, the people already on this concern, HR or the CEO can add someone.';
  END IF;

  SELECT o.full_name, o.staff_id INTO v_to, v_staff
    FROM public.cc_forward_staff_options() o
   WHERE o.user_id = p_user_id;
  IF v_to IS NULL THEN
    RAISE EXCEPTION 'That person cannot receive concerns. Choose a staff member with an active employee role.';
  END IF;

  v_prev := public.cc_concern_participants_text(p_concern_id);

  SELECT * INTO v_existing FROM public.cc_concern_reviewers
   WHERE concern_id = p_concern_id AND user_id = p_user_id;

  IF v_existing.id IS NOT NULL AND v_existing.removed_at IS NULL THEN
    RETURN jsonb_build_object('success', true, 'already_present', true, 'reviewer_name', v_to);
  END IF;

  SELECT coalesce(nullif(btrim(full_name), ''), 'Officer') INTO v_by FROM public.profiles WHERE id = v_uid;

  IF v_existing.id IS NOT NULL THEN
    -- Previously removed: bring them back without erasing the earlier record.
    UPDATE public.cc_concern_reviewers
       SET removed_at = NULL, removed_by = NULL, removed_by_name = NULL, remove_reason = NULL,
           added_by = v_uid, added_by_name = v_by,
           added_reason = nullif(btrim(coalesce(p_note,'')), ''),
           notified_at = now(), acknowledged_at = NULL
     WHERE id = v_existing.id;
  ELSE
    INSERT INTO public.cc_concern_reviewers (
      concern_id, user_id, staff_id, full_name, role, added_by, added_by_name, note, added_reason, notified_at
    ) VALUES (
      p_concern_id, p_user_id, v_staff, v_to, 'reviewer', v_uid, v_by,
      nullif(btrim(coalesce(p_note,'')), ''), nullif(btrim(coalesce(p_note,'')), ''), now()
    );
  END IF;

  v_new := public.cc_concern_participants_text(p_concern_id);

  INSERT INTO public.cc_forwarded_concern_events (
    concern_id, action, actor_id, actor_name, note, new_user_id, new_user_name, reason,
    prev_recipients, new_recipients
  ) VALUES (
    p_concern_id, 'reviewer_added', v_uid, v_by, nullif(btrim(coalesce(p_note,'')), ''),
    p_user_id, v_to, nullif(btrim(coalesce(p_note,'')), ''), v_prev, v_new
  );

  UPDATE public.cc_forwarded_concerns SET updated_at = now() WHERE id = p_concern_id;

  RETURN jsonb_build_object(
    'success', true, 'already_present', false, 'reviewer_name', v_to,
    'previous_recipients', v_prev, 'new_recipients', v_new
  );
END $$;

CREATE OR REPLACE FUNCTION public.cc_remove_concern_reviewer(
  p_concern_id uuid, p_user_id uuid, p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.cc_forwarded_concerns;
  v_by text;
  v_existing public.cc_concern_reviewers;
  v_active integer;
  v_prev text;
  v_new text;
BEGIN
  IF v_uid IS NULL OR NOT (is_welile_staff(v_uid) OR has_role(v_uid, 'super_admin')) THEN
    RAISE EXCEPTION 'Only Welile staff can remove someone from a concern.';
  END IF;

  SELECT * INTO v_row FROM public.cc_forwarded_concerns WHERE id = p_concern_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Concern not found.';
  END IF;

  IF NOT public.cc_can_manage_concern_participants(p_concern_id, v_uid) THEN
    RAISE EXCEPTION 'Only the sender, the people already on this concern, HR or the CEO can remove someone.';
  END IF;

  IF length(btrim(coalesce(p_reason,''))) < 5 THEN
    RAISE EXCEPTION 'Say why this person is being taken off (at least 5 characters).';
  END IF;

  SELECT * INTO v_existing FROM public.cc_concern_reviewers
   WHERE concern_id = p_concern_id AND user_id = p_user_id AND removed_at IS NULL;
  IF v_existing.id IS NULL THEN
    RAISE EXCEPTION 'That person is not currently on this concern.';
  END IF;

  SELECT count(*) INTO v_active FROM public.cc_concern_reviewers
   WHERE concern_id = p_concern_id AND removed_at IS NULL;
  IF v_active <= 1 THEN
    RAISE EXCEPTION 'A concern must keep at least one person on it. Add someone else first.';
  END IF;

  SELECT coalesce(nullif(btrim(full_name), ''), 'Officer') INTO v_by FROM public.profiles WHERE id = v_uid;
  v_prev := public.cc_concern_participants_text(p_concern_id);

  UPDATE public.cc_concern_reviewers
     SET removed_at = now(), removed_by = v_uid, removed_by_name = v_by,
         remove_reason = btrim(p_reason)
   WHERE id = v_existing.id;

  v_new := public.cc_concern_participants_text(p_concern_id);

  INSERT INTO public.cc_forwarded_concern_events (
    concern_id, action, actor_id, actor_name, note, prev_user_id, prev_user_name, reason,
    prev_recipients, new_recipients
  ) VALUES (
    p_concern_id, 'reviewer_removed', v_uid, v_by, btrim(p_reason),
    p_user_id, v_existing.full_name, btrim(p_reason), v_prev, v_new
  );

  -- Keep the headline handler pointing at someone still on the concern.
  IF v_row.forwarded_to = p_user_id THEN
    UPDATE public.cc_forwarded_concerns c
       SET forwarded_to = r.user_id,
           forwarded_to_staff_id = r.staff_id,
           forwarded_to_name = r.full_name,
           updated_at = now()
      FROM (
        SELECT user_id, staff_id, full_name
          FROM public.cc_concern_reviewers
         WHERE concern_id = p_concern_id AND removed_at IS NULL
         ORDER BY created_at ASC LIMIT 1
      ) r
     WHERE c.id = p_concern_id;
  ELSE
    UPDATE public.cc_forwarded_concerns SET updated_at = now() WHERE id = p_concern_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'removed_name', v_existing.full_name,
    'previous_recipients', v_prev, 'new_recipients', v_new
  );
END $$;

DROP FUNCTION IF EXISTS public.cc_concern_reviewer_list(uuid[]);
CREATE OR REPLACE FUNCTION public.cc_concern_reviewer_list(p_concern_ids uuid[])
RETURNS TABLE(
  concern_id uuid, user_id uuid, full_name text, role text,
  added_by_name text, created_at timestamptz, added_reason text, note text,
  notified_at timestamptz, acknowledged_at timestamptz,
  removed_at timestamptz, removed_by_name text, remove_reason text, active boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT r.concern_id, r.user_id, r.full_name, r.role,
         r.added_by_name, r.created_at, r.added_reason, r.note,
         r.notified_at, r.acknowledged_at,
         r.removed_at, r.removed_by_name, r.remove_reason,
         (r.removed_at IS NULL) AS active
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

-- Acknowledgement: confirming receipt stamps the person's own participant row.
CREATE OR REPLACE FUNCTION public.cc_concern_event(
  p_concern_id uuid, p_action text, p_note text DEFAULT NULL,
  p_follow_up_needed boolean DEFAULT NULL, p_follow_up_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
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
     WHERE r.concern_id = p_concern_id AND r.user_id = v_uid AND r.removed_at IS NULL
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

  IF p_action IN ('accepted','started','completed') THEN
    UPDATE public.cc_concern_reviewers
       SET acknowledged_at = coalesce(acknowledged_at, now())
     WHERE concern_id = p_concern_id AND user_id = v_uid AND removed_at IS NULL;
  END IF;

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

CREATE OR REPLACE FUNCTION public.cc_concern_powers()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_hr boolean := false;
  v_ceo boolean := false;
  v_admin boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('can_reassign', false, 'can_set_due', false, 'is_hr', false, 'is_ceo', false, 'is_super_admin', false);
  END IF;
  v_hr := public.has_role(v_uid, 'hr'::app_role);
  v_ceo := public.has_role(v_uid, 'ceo'::app_role);
  v_admin := public.has_role(v_uid, 'super_admin'::app_role);
  RETURN jsonb_build_object(
    'can_reassign', (v_hr OR v_ceo OR v_admin),
    'can_set_due', (v_hr OR v_ceo OR v_admin),
    'is_hr', v_hr,
    'is_ceo', v_ceo,
    'is_super_admin', v_admin
  );
END;
$$;

-- Backfill: existing participants were notified when they were added.
UPDATE public.cc_concern_reviewers SET notified_at = created_at WHERE notified_at IS NULL;

GRANT EXECUTE ON FUNCTION public.cc_concern_participants_text(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cc_can_manage_concern_participants(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cc_add_concern_reviewer(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cc_remove_concern_reviewer(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cc_concern_reviewer_list(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cc_concern_event(uuid, text, text, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cc_concern_powers() TO authenticated;