DROP POLICY IF EXISTS "Managers can view audit logs" ON public.audit_logs;
CREATE POLICY "Managers or CEO can view audit logs"
ON public.audit_logs FOR SELECT
USING (has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'ceo'::app_role));