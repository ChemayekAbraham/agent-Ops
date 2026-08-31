CREATE OR REPLACE FUNCTION public.cc_my_open_attempts()
RETURNS TABLE(
  attempt_id uuid,
  cycle_row_id uuid,
  attempt_no integer,
  revealed_at timestamptz,
  subject_type public.cc_subject_type,
  name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id AS attempt_id,
         a.cycle_row_id,
         a.attempt_no,
         a.revealed_at,
         q.subject_type,
         COALESCE(q.name, 'Unnamed') AS name
    FROM public.cc_call_attempts a
    LEFT JOIN public.v_cc_call_queue q ON q.cycle_row_id = a.cycle_row_id
   WHERE a.caller_id = auth.uid()
     AND a.recorded_at IS NULL
   ORDER BY a.revealed_at ASC NULLS LAST, a.created_at ASC
$$;

REVOKE EXECUTE ON FUNCTION public.cc_my_open_attempts() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cc_my_open_attempts() FROM anon;
GRANT EXECUTE ON FUNCTION public.cc_my_open_attempts() TO authenticated;