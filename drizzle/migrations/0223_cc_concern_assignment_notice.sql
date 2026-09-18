-- Calling Center: forwarded-concern assignment notice.
-- Additive only. No change to forwarding permissions, concern statuses, the
-- event/audit trail, or any existing function body.

ALTER TABLE public.cc_concern_reviewers
  ALTER COLUMN notified_at SET DEFAULT now();

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
     AND r.acknowledged_at IS NULL
     AND c.status <> 'completed'
   ORDER BY c.created_at DESC;
$function$;

REVOKE ALL ON FUNCTION public.cc_my_pending_concerns() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_my_pending_concerns() TO authenticated;

-- Records that the signed-in person has seen the concern(s). Only ever touches
-- the caller's own reviewer row; never the concern status or the event trail.
CREATE OR REPLACE FUNCTION public.cc_acknowledge_concern(p_concern_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_count integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in first.';
  END IF;

  UPDATE public.cc_concern_reviewers
     SET acknowledged_at = now(),
         notified_at = coalesce(notified_at, now())
   WHERE user_id = v_uid
     AND removed_at IS NULL
     AND acknowledged_at IS NULL
     AND (p_concern_id IS NULL OR concern_id = p_concern_id);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $function$;

REVOKE ALL ON FUNCTION public.cc_acknowledge_concern(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_acknowledge_concern(uuid) TO authenticated;