-- WELILE-TIX-STOR-11J
-- Replace team-wide task-evidence storage policies with per-task / per-ticket
-- scoped, single-command policies.

DROP POLICY IF EXISTS task_evidence_insert_team ON storage.objects;
DROP POLICY IF EXISTS task_evidence_select_team ON storage.objects;
DROP POLICY IF EXISTS "task-evidence insert" ON storage.objects;
DROP POLICY IF EXISTS "task-evidence read" ON storage.objects;

-- 1. Task evidence upload
DROP POLICY IF EXISTS task_evidence_task_insert ON storage.objects;
CREATE POLICY task_evidence_task_insert
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'task-evidence'
  AND (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  AND name ~* '\.(jpg|jpeg|png|webp|pdf)$'
  AND EXISTS (
    SELECT 1
      FROM public.hr_tasks t
     WHERE t.id = ((storage.foldername(name))[1])::uuid
       AND (
         t.assignee_staff_id = public.hr_my_staff_id()
         OR public.hr_manages(t.assignee_staff_id)
         OR public.hr_is_admin()
         OR public.hr_is_executive()
       )
  )
);

-- 2. Task evidence read
DROP POLICY IF EXISTS task_evidence_task_read ON storage.objects;
CREATE POLICY task_evidence_task_read
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'task-evidence'
  AND (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  AND EXISTS (
    SELECT 1
      FROM public.hr_tasks t
     WHERE t.id = ((storage.foldername(name))[1])::uuid
       AND (
         t.assignee_staff_id = public.hr_my_staff_id()
         OR public.hr_manages(t.assignee_staff_id)
         OR public.hr_is_admin()
         OR public.hr_is_executive()
       )
  )
);

-- 3. Ticket evidence upload (raiser only, unassigned ticket)
DROP POLICY IF EXISTS task_evidence_ticket_insert ON storage.objects;
CREATE POLICY task_evidence_ticket_insert
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'task-evidence'
  AND (storage.foldername(name))[1] = 'tickets'
  AND (storage.foldername(name))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  AND EXISTS (
    SELECT 1
      FROM public.hr_tickets k
     WHERE k.id = ((storage.foldername(name))[2])::uuid
       AND k.raised_by = public.hr_my_staff_id()
       AND k.task_id IS NULL
  )
);

-- 4. Ticket evidence read (delegates visibility to hr_tickets RLS)
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
  )
);