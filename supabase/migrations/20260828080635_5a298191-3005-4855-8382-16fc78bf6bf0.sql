ALTER TABLE public.hr_staff
  ADD COLUMN ended_on date,
  ADD COLUMN exit_reason text;

ALTER TABLE public.hr_staff
  ADD CONSTRAINT hr_staff_exit_reason_ck CHECK (
    (ended_on IS NULL AND exit_reason IS NULL)
    OR (ended_on IS NOT NULL AND length(btrim(exit_reason)) >= 10)
  );

ALTER TABLE public.hr_staff
  ADD CONSTRAINT hr_staff_exit_active_ck CHECK (
    ended_on IS NULL OR active = false
  );

CREATE POLICY hr_staff_exit_update ON public.hr_staff
  FOR UPDATE
  TO authenticated
  USING (hr_is_admin())
  WITH CHECK (hr_is_admin());