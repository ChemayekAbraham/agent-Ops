-- Allow merchant agents to raise and track their own float requisitions.
DROP POLICY IF EXISTS "Agents create own float requests" ON public.float_requests;
CREATE POLICY "Agents create own float requests"
ON public.float_requests
FOR INSERT
TO authenticated
WITH CHECK (agent_id = auth.uid());

DROP POLICY IF EXISTS "Agents view own float requests" ON public.float_requests;
CREATE POLICY "Agents view own float requests"
ON public.float_requests
FOR SELECT
TO authenticated
USING (agent_id = auth.uid());
