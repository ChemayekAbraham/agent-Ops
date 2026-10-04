-- Fix: Staff with update permission can't see records because SELECT policy is too restrictive
-- Add a staff SELECT policy matching the existing UPDATE policy

CREATE POLICY "Staff can view all agent_subagents"
ON public.agent_subagents FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'operations'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
);