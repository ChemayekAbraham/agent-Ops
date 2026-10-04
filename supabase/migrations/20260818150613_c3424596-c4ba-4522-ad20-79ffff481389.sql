-- Employees may file their own leave requests and see them.
CREATE POLICY employees_insert_own_leave
  ON public.leave_requests
  FOR INSERT
  TO authenticated
  WITH CHECK (
    employee_id = (SELECT auth.uid())
    AND status = 'pending'
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
    AND review_note IS NULL
  );

GRANT SELECT, INSERT ON public.leave_requests TO authenticated;
GRANT ALL ON public.leave_requests TO service_role;