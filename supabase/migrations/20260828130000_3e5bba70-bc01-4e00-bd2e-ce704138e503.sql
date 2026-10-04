-- "My submissions" listed only budgets belonging to the caller's HOME
-- department, so a budget the caller filed under any other department
-- disappeared from the panel the moment it was saved:
--
--   * a user with more than one active posting who filed under a posting
--     that is not their home department never saw their own submission;
--   * a budget reviewer filing on behalf of a department (permitted by
--     budget_save_draft, which skips budget_can_file_for_department for
--     reviewers) never saw it either.
--
-- The row was saved and submitted correctly and stayed visible to the
-- reviewer queues; only the submitter's own list was blind to it, which
-- reads as a failed submission.
--
-- Fix: also return submissions the caller filed. budget_save_draft already
-- stamps submitted_by_user_id with the creator at draft creation, so this
-- covers drafts as well as submitted budgets.
--
-- No widening of visibility: the budget_submissions SELECT policy added in
-- 20260820084824 already grants the caller rows where
-- submitted_by_user_id = auth.uid(). This aligns the listing function with
-- the policy that governs the same table rather than exceeding it.

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
     AND (
       bs.submitted_by_user_id = auth.uid()
       OR bs.department_id = public.budget_home_department_id(auth.uid())
     )
     AND (p_call_id IS NULL OR bs.call_id = p_call_id)
   ORDER BY bs.created_at DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.budget_my_submissions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.budget_my_submissions(uuid) TO authenticated, service_role;
