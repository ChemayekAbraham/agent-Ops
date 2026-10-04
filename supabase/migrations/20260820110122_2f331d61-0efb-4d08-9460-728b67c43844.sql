DROP POLICY IF EXISTS task_evidence_insert_team ON storage.objects;
CREATE POLICY task_evidence_insert_team
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'task-evidence' AND public.hr_my_staff_id() IS NOT NULL);

DROP POLICY IF EXISTS task_evidence_select_team ON storage.objects;
CREATE POLICY task_evidence_select_team
ON storage.objects
FOR SELECT
TO authenticated
USING (bucket_id = 'task-evidence' AND public.hr_my_staff_id() IS NOT NULL);

ALTER TABLE public.hr_task_attachments ADD COLUMN IF NOT EXISTS delete_after date;