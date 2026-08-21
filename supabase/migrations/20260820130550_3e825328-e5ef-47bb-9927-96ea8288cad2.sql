REVOKE ALL ON public.hr_task_attachments FROM anon;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.hr_task_attachments FROM authenticated;

DROP POLICY IF EXISTS hr_task_attachments_insert ON public.hr_task_attachments;
DROP POLICY IF EXISTS hr_task_attachments_select ON public.hr_task_attachments;
DROP POLICY IF EXISTS hr_task_attachments_update ON public.hr_task_attachments;

DROP POLICY IF EXISTS hr_task_attachments_task_insert ON public.hr_task_attachments;
CREATE POLICY hr_task_attachments_task_insert ON public.hr_task_attachments
  FOR INSERT TO authenticated
  WITH CHECK (
    task_id IS NOT NULL
    AND uploaded_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.hr_tasks t
      WHERE t.id = task_id
        AND (
          t.assignee_staff_id = public.hr_my_staff_id()
          OR public.hr_manages(t.assignee_staff_id)
          OR public.hr_is_admin()
          OR public.hr_is_executive()
        )
    )
  );

DROP POLICY IF EXISTS hr_task_attachments_task_select ON public.hr_task_attachments;
CREATE POLICY hr_task_attachments_task_select ON public.hr_task_attachments
  FOR SELECT TO authenticated
  USING (
    task_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.hr_tasks t
      WHERE t.id = task_id
        AND (
          t.assignee_staff_id = public.hr_my_staff_id()
          OR public.hr_manages(t.assignee_staff_id)
          OR public.hr_is_admin()
          OR public.hr_is_executive()
        )
    )
  );

DROP POLICY IF EXISTS hr_task_attachments_task_update ON public.hr_task_attachments;
CREATE POLICY hr_task_attachments_task_update ON public.hr_task_attachments
  FOR UPDATE TO authenticated
  USING (
    task_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.hr_tasks t
      WHERE t.id = task_id
        AND (
          t.assignee_staff_id = public.hr_my_staff_id()
          OR public.hr_manages(t.assignee_staff_id)
          OR public.hr_is_admin()
          OR public.hr_is_executive()
        )
    )
  )
  WITH CHECK (
    task_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.hr_tasks t
      WHERE t.id = task_id
        AND (
          t.assignee_staff_id = public.hr_my_staff_id()
          OR public.hr_manages(t.assignee_staff_id)
          OR public.hr_is_admin()
          OR public.hr_is_executive()
        )
    )
  );

DROP POLICY IF EXISTS hr_task_attachments_ticket_insert ON public.hr_task_attachments;
CREATE POLICY hr_task_attachments_ticket_insert ON public.hr_task_attachments
  FOR INSERT TO authenticated
  WITH CHECK (
    ticket_id IS NOT NULL
    AND uploaded_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.hr_tickets k
      WHERE k.id = ticket_id
        AND k.raised_by = public.hr_my_staff_id()
        AND k.task_id IS NULL
    )
  );

DROP POLICY IF EXISTS hr_task_attachments_ticket_select ON public.hr_task_attachments;
CREATE POLICY hr_task_attachments_ticket_select ON public.hr_task_attachments
  FOR SELECT TO authenticated
  USING (
    ticket_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.hr_tickets k
      WHERE k.id = ticket_id
    )
  );