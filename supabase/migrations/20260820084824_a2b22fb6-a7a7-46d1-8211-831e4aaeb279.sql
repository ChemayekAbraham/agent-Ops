-- 1. Single authoritative "home" department per user (primary HR assignment, else ops department)
CREATE OR REPLACE FUNCTION public.budget_home_department_id(_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT a.department_id
        FROM hr_assignments a
        JOIN hr_staff s ON s.id = a.staff_id
        JOIN hr_departments d ON d.id = a.department_id AND d.active
       WHERE s.user_id = _user_id
         AND (a.ended_on IS NULL OR a.ended_on >= CURRENT_DATE)
       ORDER BY a.is_primary DESC NULLS LAST, a.started_on DESC NULLS LAST
       LIMIT 1
    ),
    (
      SELECT d.id
        FROM operations_departments od
        JOIN hr_departments d ON lower(d.key) = lower(od.department) AND d.active
       WHERE od.user_id = _user_id
       ORDER BY od.created_at ASC NULLS LAST
       LIMIT 1
    )
  );
$$;

REVOKE EXECUTE ON FUNCTION public.budget_home_department_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.budget_home_department_id(uuid) TO authenticated, service_role;

-- 2. Submission read scope: own row, own home department, or reviewer workflow
DROP POLICY IF EXISTS budget_submissions_read ON public.budget_submissions;
CREATE POLICY budget_submissions_read
ON public.budget_submissions
FOR SELECT
TO authenticated
USING (
  submitted_by_user_id = (SELECT auth.uid())
  OR department_id = public.budget_home_department_id((SELECT auth.uid()))
  OR public.is_budget_reviewer((SELECT auth.uid()))
  OR (
    public.is_budget_coo_reviewer((SELECT auth.uid()))
    AND public.budget_department_route(department_id) = 'coo'
  )
);

-- 3. Same scope for lines / events / documents
CREATE OR REPLACE FUNCTION public.can_access_budget_submission(_submission_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_budget_reviewer(_user_id)
      OR EXISTS (
        SELECT 1 FROM budget_submissions bs
        WHERE bs.id = _submission_id
          AND (bs.submitted_by_user_id = _user_id
               OR bs.department_id = public.budget_home_department_id(_user_id)
               OR (public.is_budget_coo_reviewer(_user_id)
                   AND public.budget_department_route(bs.department_id) = 'coo'))
      );
$$;

-- 4. Server-side department-scoped list for the "My submissions" panel
CREATE OR REPLACE FUNCTION public.budget_my_submissions(p_call_id uuid DEFAULT NULL)
RETURNS SETOF public.budget_submissions
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT bs.*
    FROM budget_submissions bs
   WHERE bs.department_id IS NOT NULL
     AND bs.department_id = public.budget_home_department_id(auth.uid())
     AND (p_call_id IS NULL OR bs.call_id = p_call_id)
   ORDER BY bs.created_at DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.budget_my_submissions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.budget_my_submissions(uuid) TO authenticated, service_role;