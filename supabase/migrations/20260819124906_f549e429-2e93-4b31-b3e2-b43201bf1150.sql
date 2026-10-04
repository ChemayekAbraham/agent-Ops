ALTER TABLE public.hr_positions ADD COLUMN IF NOT EXISTS can_assign_tasks boolean NOT NULL DEFAULT false;

UPDATE public.hr_positions SET can_assign_tasks = true WHERE key IN ('ceo', 'lead_engineer', 'hr_lead');

CREATE OR REPLACE FUNCTION public.hr_my_department_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT a.department_id
  FROM public.hr_assignments a
  WHERE a.staff_id = public.hr_my_staff_id()
    AND a.is_primary IS TRUE
    AND a.ended_on IS NULL
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.hr_is_engineering()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (
      SELECT public.hr_my_department_id() = d.id
      FROM public.hr_departments d
      WHERE d.key = 'engineering'
      LIMIT 1
    ),
    false
  )
$$;

CREATE OR REPLACE FUNCTION public.hr_can_assign_tasks()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.hr_assignments a
    JOIN public.hr_positions p ON p.id = a.position_id
    WHERE a.staff_id = public.hr_my_staff_id()
      AND a.is_primary IS TRUE
      AND a.ended_on IS NULL
      AND p.can_assign_tasks IS TRUE
  )
$$;

GRANT SELECT, INSERT, UPDATE ON public.hr_tickets TO authenticated;
GRANT SELECT ON public.hr_ticket_surfaces TO authenticated;
GRANT INSERT, UPDATE ON public.hr_ticket_surfaces TO authenticated;
GRANT SELECT ON public.hr_review_weeks TO authenticated;

DROP POLICY IF EXISTS hr_tickets_select_queue ON public.hr_tickets;
CREATE POLICY hr_tickets_select_queue ON public.hr_tickets
FOR SELECT TO authenticated
USING (task_id IS NULL AND closed_no_task_at IS NULL AND public.hr_my_staff_id() IS NOT NULL);

DROP POLICY IF EXISTS hr_tickets_select_own ON public.hr_tickets;
CREATE POLICY hr_tickets_select_own ON public.hr_tickets
FOR SELECT TO authenticated
USING (raised_by = public.hr_my_staff_id());

DROP POLICY IF EXISTS hr_tickets_select_assignee ON public.hr_tickets;
CREATE POLICY hr_tickets_select_assignee ON public.hr_tickets
FOR SELECT TO authenticated
USING (task_id IS NOT NULL AND task_id IN (SELECT t.id FROM public.hr_tasks t WHERE t.assignee_staff_id = public.hr_my_staff_id()));

DROP POLICY IF EXISTS hr_tickets_select_assigners ON public.hr_tickets;
CREATE POLICY hr_tickets_select_assigners ON public.hr_tickets
FOR SELECT TO authenticated
USING (public.hr_can_assign_tasks());

DROP POLICY IF EXISTS hr_tickets_insert_own ON public.hr_tickets;
CREATE POLICY hr_tickets_insert_own ON public.hr_tickets
FOR INSERT TO authenticated
WITH CHECK (public.hr_my_staff_id() IS NOT NULL AND raised_by = public.hr_my_staff_id());

DROP POLICY IF EXISTS hr_tickets_update_own_preclaim ON public.hr_tickets;
CREATE POLICY hr_tickets_update_own_preclaim ON public.hr_tickets
FOR UPDATE TO authenticated
USING (raised_by = public.hr_my_staff_id() AND task_id IS NULL AND closed_no_task_at IS NULL)
WITH CHECK (raised_by = public.hr_my_staff_id() AND task_id IS NULL AND closed_no_task_at IS NULL);

DROP POLICY IF EXISTS hr_ticket_surfaces_select_staff ON public.hr_ticket_surfaces;
CREATE POLICY hr_ticket_surfaces_select_staff ON public.hr_ticket_surfaces
FOR SELECT TO authenticated
USING (public.hr_my_staff_id() IS NOT NULL);

DROP POLICY IF EXISTS hr_ticket_surfaces_insert_admin ON public.hr_ticket_surfaces;
CREATE POLICY hr_ticket_surfaces_insert_admin ON public.hr_ticket_surfaces
FOR INSERT TO authenticated
WITH CHECK (public.hr_is_admin());

DROP POLICY IF EXISTS hr_ticket_surfaces_update_admin ON public.hr_ticket_surfaces;
CREATE POLICY hr_ticket_surfaces_update_admin ON public.hr_ticket_surfaces
FOR UPDATE TO authenticated
USING (public.hr_is_admin())
WITH CHECK (public.hr_is_admin());

DROP POLICY IF EXISTS hr_review_weeks_select_staff ON public.hr_review_weeks;
CREATE POLICY hr_review_weeks_select_staff ON public.hr_review_weeks
FOR SELECT TO authenticated
USING (public.hr_my_staff_id() IS NOT NULL);