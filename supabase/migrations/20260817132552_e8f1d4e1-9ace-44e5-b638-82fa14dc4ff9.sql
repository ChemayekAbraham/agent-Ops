BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='user_roles' AND column_name='enabled'
  ) THEN
    RAISE EXCEPTION 'wrong database';
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS public.hr_task_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.hr_tasks(id),
  event_id uuid NULL REFERENCES public.hr_task_events(id),
  kind text NOT NULL,
  storage_path text NOT NULL,
  caption text NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL,
  uploaded_by uuid NOT NULL DEFAULT auth.uid(),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz NULL,
  removed_by uuid NULL,
  remove_reason text NULL
);

ALTER TABLE public.hr_task_attachments DROP CONSTRAINT IF EXISTS hr_task_attachments_kind_check;
ALTER TABLE public.hr_task_attachments ADD CONSTRAINT hr_task_attachments_kind_check
  CHECK (kind IN ('before','after','evidence'));

ALTER TABLE public.hr_task_attachments DROP CONSTRAINT IF EXISTS hr_task_attachments_size_bytes_check;
ALTER TABLE public.hr_task_attachments ADD CONSTRAINT hr_task_attachments_size_bytes_check
  CHECK (size_bytes > 0);

GRANT SELECT, INSERT, UPDATE ON public.hr_task_attachments TO authenticated;
GRANT ALL ON public.hr_task_attachments TO service_role;

CREATE UNIQUE INDEX IF NOT EXISTS hr_task_attachments_storage_path_active_uidx
  ON public.hr_task_attachments (storage_path) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS hr_task_attachments_task_id_idx
  ON public.hr_task_attachments (task_id);

ALTER TABLE public.hr_task_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hr_task_attachments_select ON public.hr_task_attachments;
CREATE POLICY hr_task_attachments_select ON public.hr_task_attachments
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.hr_tasks t
  WHERE t.id = hr_task_attachments.task_id
    AND (t.assignee_staff_id = public.hr_my_staff_id()
      OR public.hr_manages(t.assignee_staff_id)
      OR public.hr_is_admin()
      OR public.hr_is_executive())
));

DROP POLICY IF EXISTS hr_task_attachments_insert ON public.hr_task_attachments;
CREATE POLICY hr_task_attachments_insert ON public.hr_task_attachments
FOR INSERT TO authenticated
WITH CHECK (uploaded_by = auth.uid() AND EXISTS (
  SELECT 1 FROM public.hr_tasks t
  WHERE t.id = hr_task_attachments.task_id
    AND (t.assignee_staff_id = public.hr_my_staff_id()
      OR public.hr_manages(t.assignee_staff_id)
      OR public.hr_is_admin()
      OR public.hr_is_executive())
));

DROP POLICY IF EXISTS hr_task_attachments_update ON public.hr_task_attachments;
CREATE POLICY hr_task_attachments_update ON public.hr_task_attachments
FOR UPDATE TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.hr_tasks t
  WHERE t.id = hr_task_attachments.task_id
    AND (t.assignee_staff_id = public.hr_my_staff_id()
      OR public.hr_manages(t.assignee_staff_id)
      OR public.hr_is_admin()
      OR public.hr_is_executive())
))
WITH CHECK (EXISTS (
  SELECT 1 FROM public.hr_tasks t
  WHERE t.id = hr_task_attachments.task_id
    AND (t.assignee_staff_id = public.hr_my_staff_id()
      OR public.hr_manages(t.assignee_staff_id)
      OR public.hr_is_admin()
      OR public.hr_is_executive())
));

DROP POLICY IF EXISTS "task-evidence read" ON storage.objects;
CREATE POLICY "task-evidence read" ON storage.objects
FOR SELECT TO authenticated
USING (bucket_id = 'task-evidence' AND EXISTS (
  SELECT 1 FROM public.hr_tasks t
  WHERE t.id = (storage.foldername(name))[1]::uuid
    AND (t.assignee_staff_id = public.hr_my_staff_id()
      OR public.hr_manages(t.assignee_staff_id)
      OR public.hr_is_admin()
      OR public.hr_is_executive())
));

DROP POLICY IF EXISTS "task-evidence insert" ON storage.objects;
CREATE POLICY "task-evidence insert" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'task-evidence' AND EXISTS (
  SELECT 1 FROM public.hr_tasks t
  WHERE t.id = (storage.foldername(name))[1]::uuid
    AND (t.assignee_staff_id = public.hr_my_staff_id()
      OR public.hr_manages(t.assignee_staff_id)
      OR public.hr_is_admin()
      OR public.hr_is_executive())
));

COMMENT ON TABLE public.hr_task_attachments IS
  'Task evidence attachments. Removal is an UPDATE setting removed_at/removed_by/remove_reason - never a DELETE. Bucket task-evidence is private and readable only through a signed URL. Photographs of work are personal data about third parties and there is no purge mechanism yet in this project.';

COMMIT;