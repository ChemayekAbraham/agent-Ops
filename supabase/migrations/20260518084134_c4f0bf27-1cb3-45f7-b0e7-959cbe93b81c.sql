-- Allow users to view audit log entries for their own deposit requests
DROP POLICY IF EXISTS "Users view audit for own deposits" ON public.email_match_audit_log;
CREATE POLICY "Users view audit for own deposits"
ON public.email_match_audit_log FOR SELECT TO authenticated
USING (
  deposit_request_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.deposit_requests dr
    WHERE dr.id = email_match_audit_log.deposit_request_id
      AND dr.user_id = auth.uid()
  )
);