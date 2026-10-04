-- Allow agents to create landlord invites
CREATE POLICY "Agents can create landlord invites"
ON public.supporter_invites
FOR INSERT
WITH CHECK (
  has_role(auth.uid(), 'agent'::app_role) 
  AND auth.uid() = created_by
  AND role = 'landlord'
);

-- Allow agents to view their own invites
CREATE POLICY "Agents can view own invites"
ON public.supporter_invites
FOR SELECT
USING (auth.uid() = created_by);