DROP POLICY IF EXISTS "Staff can update agent_subagents status" ON public.agent_subagents;
DROP POLICY IF EXISTS "Staff can view all agent_subagents" ON public.agent_subagents;

CREATE POLICY "Staff can view all agent_subagents"
ON public.agent_subagents
FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR EXISTS (
    SELECT 1 FROM public.staff_permissions sp
    WHERE sp.user_id = auth.uid()
      AND sp.permitted_dashboard IN ('agent_ops', 'agent_operations', 'agent_ops_admin', 'executive_hub')
  )
);

CREATE POLICY "Staff can update agent_subagents status"
ON public.agent_subagents
FOR UPDATE
TO authenticated
USING (
  has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR EXISTS (
    SELECT 1 FROM public.staff_permissions sp
    WHERE sp.user_id = auth.uid()
      AND sp.permitted_dashboard IN ('agent_ops', 'agent_operations', 'agent_ops_admin', 'executive_hub')
  )
)
WITH CHECK (
  has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR EXISTS (
    SELECT 1 FROM public.staff_permissions sp
    WHERE sp.user_id = auth.uid()
      AND sp.permitted_dashboard IN ('agent_ops', 'agent_operations', 'agent_ops_admin', 'executive_hub')
  )
);