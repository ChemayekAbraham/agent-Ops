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

ALTER TABLE public.hr_task_attachments
  DROP CONSTRAINT IF EXISTS hr_task_attachments_mime_type_allowlist;
ALTER TABLE public.hr_task_attachments
  ADD CONSTRAINT hr_task_attachments_mime_type_allowlist
  CHECK (mime_type IN ('image/jpeg','image/png','image/webp','application/pdf'));

ALTER TABLE public.hr_task_attachments
  DROP CONSTRAINT IF EXISTS hr_task_attachments_size_bytes_max;
ALTER TABLE public.hr_task_attachments
  ADD CONSTRAINT hr_task_attachments_size_bytes_max
  CHECK (size_bytes <= 10485760);

DROP POLICY IF EXISTS "task-evidence insert" ON storage.objects;
CREATE POLICY "task-evidence insert"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'task-evidence'
  AND name ~* '\.(jpg|jpeg|png|webp|pdf)$'
  AND EXISTS (
    SELECT 1 FROM public.hr_tasks t
    WHERE t.id = ((storage.foldername(storage.objects.name))[1])::uuid
      AND (t.assignee_staff_id = public.hr_my_staff_id()
        OR public.hr_manages(t.assignee_staff_id)
        OR public.hr_is_admin()
        OR public.hr_is_executive())
  )
);

COMMENT ON COLUMN public.hr_task_attachments.mime_type IS
  'The task-evidence bucket carries no MIME allowlist because writes to storage.buckets are blocked on this platform; the allowlist lives in the hr_task_attachments_mime_type_allowlist check constraint and in the "task-evidence insert" storage policy instead.';

COMMIT;