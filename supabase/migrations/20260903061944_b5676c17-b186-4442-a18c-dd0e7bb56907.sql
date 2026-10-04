DROP POLICY IF EXISTS task_evidence_ticket_read ON storage.objects;
CREATE POLICY task_evidence_ticket_read
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'task-evidence'
  AND (storage.foldername(name))[1] = 'tickets'
  AND (storage.foldername(name))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  AND EXISTS (
    SELECT 1
      FROM public.hr_tickets k
     WHERE k.id = ((storage.foldername(name))[2])::uuid
       AND (
         k.raised_by = public.hr_my_staff_id()
         OR public.hr_manages(k.raised_by)
         OR public.hr_is_admin()
         OR public.hr_is_executive()
       )
  )
);