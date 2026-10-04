-- Add update and delete policies for managers on audit_logs
CREATE POLICY "Managers can update audit logs" 
ON public.audit_logs 
FOR UPDATE 
USING (has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "Managers can delete audit logs" 
ON public.audit_logs 
FOR DELETE 
USING (has_role(auth.uid(), 'manager'::app_role));