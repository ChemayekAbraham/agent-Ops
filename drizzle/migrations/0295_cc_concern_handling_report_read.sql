-- Read-only reporting source for the Calling Center combined report's
-- "Staff Concern Handling Summary". The per-row RLS on cc_forwarded_concerns
-- only shows a concern to the officer who raised it, the staff member it went
-- to, its reviewers or an overseer, so the report built by one officer silently
-- omitted every concern forwarded by someone else -- in practice all the
-- concerns raised from received calls. This function returns the summary-level
-- fields only (no concern text or context) for the report window, to staff.
CREATE OR REPLACE FUNCTION public.cc_concern_handling_report(
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE(
  id uuid,
  source_kind text,
  received_call_id uuid,
  cycle_row_id uuid,
  forwarded_to_name text,
  status text,
  created_at timestamptz,
  completed_at timestamptz,
  due_at timestamptz,
  due_is_custom boolean,
  reassigned_count integer,
  reviewer_names text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT c.id,
         c.source_kind,
         c.received_call_id,
         c.cycle_row_id,
         c.forwarded_to_name,
         c.status,
         c.created_at,
         c.completed_at,
         c.due_at,
         c.due_is_custom,
         c.reassigned_count,
         COALESCE(
           (SELECT array_agg(DISTINCT r.full_name)
              FROM public.cc_concern_reviewers r
             WHERE r.concern_id = c.id
               AND r.full_name IS NOT NULL),
           ARRAY[]::text[]
         ) AS reviewer_names
    FROM public.cc_forwarded_concerns c
   WHERE c.created_at >= p_from
     AND c.created_at < p_to
     AND auth.uid() IS NOT NULL
     AND (
       public.is_welile_staff(auth.uid())
       OR public.is_cc_concern_overseer(auth.uid())
       OR public.has_role(auth.uid(), 'super_admin'::app_role)
     )
   ORDER BY c.created_at DESC
$$;

GRANT EXECUTE ON FUNCTION public.cc_concern_handling_report(timestamptz, timestamptz) TO authenticated;
