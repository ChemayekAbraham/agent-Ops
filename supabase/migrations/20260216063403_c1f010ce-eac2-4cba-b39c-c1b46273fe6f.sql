-- Allow agents to create profiles on behalf of tenants (for proxy rent requests)
CREATE POLICY "Agents can insert profiles for tenants"
ON public.profiles
FOR INSERT
TO authenticated
WITH CHECK (has_role(auth.uid(), 'agent'::app_role));

-- Allow agents to create rent requests on behalf of tenants
CREATE POLICY "Agents can create rent requests for tenants"
ON public.rent_requests
FOR INSERT
TO authenticated
WITH CHECK (has_role(auth.uid(), 'agent'::app_role) AND auth.uid() = agent_id);