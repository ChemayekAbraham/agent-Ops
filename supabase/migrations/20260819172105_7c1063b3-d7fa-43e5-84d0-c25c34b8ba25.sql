INSERT INTO public.hr_review_weeks (week_ending)
SELECT d::date
FROM generate_series('2026-08-21'::date, '2027-12-31'::date, '7 days'::interval) AS g(d)
ON CONFLICT DO NOTHING;

REVOKE UPDATE ON public.hr_review_weeks FROM authenticated;
GRANT UPDATE (locked_at, locked_by) ON public.hr_review_weeks TO authenticated;
REVOKE DELETE ON public.hr_review_weeks FROM authenticated;
REVOKE MAINTAIN ON public.hr_review_weeks FROM authenticated;
REVOKE TRUNCATE ON public.hr_review_weeks FROM authenticated;
REVOKE REFERENCES ON public.hr_review_weeks FROM authenticated;
REVOKE TRIGGER ON public.hr_review_weeks FROM authenticated;
REVOKE ALL ON public.hr_review_weeks FROM anon;

DROP POLICY IF EXISTS hr_review_weeks_insert_reviewer ON public.hr_review_weeks;
CREATE POLICY hr_review_weeks_insert_reviewer
  ON public.hr_review_weeks
  FOR INSERT
  TO authenticated
  WITH CHECK (public.hr_can_assign_tasks());

DROP POLICY IF EXISTS hr_review_weeks_update_lock ON public.hr_review_weeks;
CREATE POLICY hr_review_weeks_update_lock
  ON public.hr_review_weeks
  FOR UPDATE
  TO authenticated
  USING (public.hr_can_assign_tasks() AND locked_at IS NULL)
  WITH CHECK (public.hr_can_assign_tasks() AND locked_at IS NOT NULL AND locked_by = public.hr_my_staff_id());

REVOKE UPDATE ON public.hr_task_assessments FROM authenticated;