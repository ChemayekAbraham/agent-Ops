-- Calling Center: make the forwarded-concern popup list driven purely by
-- concern status, not by the reviewer's acknowledged_at flag.
--
-- Bug: cc_my_pending_concerns() required r.acknowledged_at IS NULL, and
-- cc_acknowledge_concern() (called when the popup is closed or "View
-- Concerns" is clicked) permanently set acknowledged_at. So closing the
-- popup once made it stop reappearing for that concern forever, even while
-- the concern's own status stayed open (sent/received/in_progress) -- the
-- popup effectively treated "seen" as "done".
--
-- Fix: drop the acknowledged_at condition from the pending-list query.
-- "Still needs the popup" now means only: an active (non-removed) reviewer
-- row for this person on a concern whose status <> 'completed' -- the same
-- authoritative status the rest of the app already treats as the only
-- finished state (see ConcernStatus / CONCERN_STATUS_LABEL in
-- useCallingConcerns.ts and MyConcerns.tsx's openCount).
--
-- cc_acknowledge_concern() is left exactly as-is and still called by the
-- gate on close/View Concerns: it drives the separate, pre-existing
-- "Confirmed" vs "Notified ... not confirmed" badge shown to the forwarding
-- officer in ConcernParticipantsPanel.tsx, which this change does not touch.
-- No forwarding, permission, assignment, status, or audit-trail behaviour
-- changes.

CREATE OR REPLACE FUNCTION public.cc_my_pending_concerns()
RETURNS TABLE(
  concern_id uuid,
  title text,
  context text,
  priority text,
  status text,
  due_at timestamp with time zone,
  caller_name text,
  subject_type text,
  forwarded_by_name text,
  added_by_name text,
  added_reason text,
  reviewer_role text,
  notified_at timestamp with time zone,
  assigned_at timestamp with time zone,
  participant_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT c.id,
         c.title,
         c.context,
         c.priority,
         c.status,
         c.due_at,
         c.caller_name,
         c.subject_type,
         c.forwarded_by_name,
         r.added_by_name,
         r.added_reason,
         r.role,
         r.notified_at,
         r.created_at,
         (SELECT count(*)::int
            FROM public.cc_concern_reviewers r2
           WHERE r2.concern_id = c.id AND r2.removed_at IS NULL)
    FROM public.cc_concern_reviewers r
    JOIN public.cc_forwarded_concerns c ON c.id = r.concern_id
   WHERE auth.uid() IS NOT NULL
     AND r.user_id = auth.uid()
     AND r.removed_at IS NULL
     AND c.status <> 'completed'
   ORDER BY c.created_at DESC;
$function$;

REVOKE ALL ON FUNCTION public.cc_my_pending_concerns() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_my_pending_concerns() TO authenticated;
