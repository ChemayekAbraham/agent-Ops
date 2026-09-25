-- Calling Center: let any active staff member browse open concerns and add
-- themselves to one, with full visibility (context, attachments, audit
-- trail) matching what an actual participant already sees, and the same
-- append-only audit trail every other hand-off already writes.
--
-- Eligibility for all three pieces below is deliberately hr_my_staff_id()
-- IS NOT NULL -- the exact same check that gates access to the My Space ->
-- Concerns page itself (PersonalLayout.tsx / personalNav.ts requiresStaff),
-- not the narrower cc_forward_staff_options() population used to choose who
-- a concern may be *forwarded* to. Management still forwards/reassigns
-- exactly as before; this only adds a self-service join path.
--
-- 1. cc_can_view_concern: an active staff member may now also see a concern
--    that is still open (status <> 'completed'), even before joining it --
--    this is what makes the audit trail, attachments and case context
--    readable the moment they open a concern from the new directory.
--    Once a concern is completed, this extra branch drops away and the
--    original rule (sender / recipient / active reviewer / named overseer)
--    is the only way to see it, same as always -- no change to how
--    finished/historical concerns are protected.
-- 2. cc_open_concerns_directory(): the list backing the new "Open Concerns"
--    tab.
-- 3. cc_join_concern(): adds the caller as a reviewer on a concern that is
--    not already theirs, logging a 'reviewer_added' event exactly like
--    cc_add_concern_reviewer() does today, so it renders in the existing
--    history/audit-trail UI with no frontend change needed there.
--
-- Nothing about forwarding, reassignment, cc_add_concern_reviewer/
-- cc_remove_concern_reviewer (management adding/removing someone else),
-- concern statuses, or the append-only event table's shape changes.

CREATE OR REPLACE FUNCTION public.cc_can_view_concern(
  p_concern_id uuid,
  p_user_id uuid DEFAULT auth.uid()
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.cc_forwarded_concerns c
     WHERE c.id = p_concern_id
       AND (
         c.forwarded_by = auth.uid()
         OR c.forwarded_to = auth.uid()
         OR EXISTS (
           SELECT 1
             FROM public.cc_concern_reviewers r
            WHERE r.concern_id = c.id
              AND r.user_id = auth.uid()
              AND r.removed_at IS NULL
         )
         OR public.is_cc_concern_overseer(auth.uid())
         OR (c.status <> 'completed' AND public.hr_my_staff_id() IS NOT NULL)
       )
  );
$$;

COMMENT ON FUNCTION public.cc_can_view_concern(uuid, uuid) IS
'Read rule for Calling Center concerns, their history, context and attachments: the sender, the current recipient, anyone still an active recipient on the thread, the named overseers -- and, while the concern is still open, any active staff member (hr_my_staff_id() IS NOT NULL), so the Open Concerns directory can show full detail before someone joins. A completed concern reverts to sender/recipient/reviewer/overseer only.';

CREATE OR REPLACE FUNCTION public.cc_open_concerns_directory()
RETURNS SETOF public.cc_forwarded_concerns
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT c.*
    FROM public.cc_forwarded_concerns c
   WHERE public.hr_my_staff_id() IS NOT NULL
     AND c.status <> 'completed'
   ORDER BY c.created_at DESC
   LIMIT 300;
$$;

REVOKE ALL ON FUNCTION public.cc_open_concerns_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_open_concerns_directory() TO authenticated;

CREATE OR REPLACE FUNCTION public.cc_join_concern(
  p_concern_id uuid,
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
  v_staff uuid;
  v_existing public.cc_concern_reviewers;
  v_prev text;
  v_new text;
  v_note text;
BEGIN
  IF v_uid IS NULL OR public.hr_my_staff_id() IS NULL THEN
    RAISE EXCEPTION 'Only active staff can add themselves to a concern.';
  END IF;

  SELECT * INTO v_row FROM public.cc_forwarded_concerns WHERE id = p_concern_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Concern not found.';
  END IF;
  IF v_row.status = 'completed' THEN
    RAISE EXCEPTION 'This concern is already completed.';
  END IF;

  v_staff := public.hr_my_staff_id();
  SELECT coalesce(nullif(btrim(full_name), ''), 'Staff member') INTO v_by
    FROM public.profiles WHERE id = v_uid;

  v_note := coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Added themselves');
  v_prev := public.cc_concern_participants_text(p_concern_id);

  SELECT * INTO v_existing FROM public.cc_concern_reviewers
   WHERE concern_id = p_concern_id AND user_id = v_uid;

  IF v_existing.id IS NOT NULL AND v_existing.removed_at IS NULL THEN
    RETURN jsonb_build_object('success', true, 'already_present', true, 'reviewer_name', v_by);
  END IF;

  IF v_existing.id IS NOT NULL THEN
    -- Previously removed: bring them back without erasing the earlier record.
    UPDATE public.cc_concern_reviewers
       SET removed_at = NULL, removed_by = NULL, removed_by_name = NULL, remove_reason = NULL,
           added_by = v_uid, added_by_name = v_by, added_reason = v_note,
           notified_at = now(), acknowledged_at = NULL
     WHERE id = v_existing.id;
  ELSE
    INSERT INTO public.cc_concern_reviewers (
      concern_id, user_id, staff_id, full_name, role, added_by, added_by_name, note, added_reason, notified_at
    ) VALUES (
      p_concern_id, v_uid, v_staff, v_by, 'reviewer', v_uid, v_by, v_note, v_note, now()
    );
  END IF;

  v_new := public.cc_concern_participants_text(p_concern_id);

  INSERT INTO public.cc_forwarded_concern_events (
    concern_id, action, actor_id, actor_name, note, new_user_id, new_user_name, reason,
    prev_recipients, new_recipients
  ) VALUES (
    p_concern_id, 'reviewer_added', v_uid, v_by, v_note, v_uid, v_by, v_note, v_prev, v_new
  );

  UPDATE public.cc_forwarded_concerns SET updated_at = now() WHERE id = p_concern_id;

  RETURN jsonb_build_object(
    'success', true, 'already_present', false, 'reviewer_name', v_by,
    'previous_recipients', v_prev, 'new_recipients', v_new
  );
END $$;

REVOKE ALL ON FUNCTION public.cc_join_concern(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_join_concern(uuid, text) TO authenticated;
