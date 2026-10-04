-- Allow the agent who created a landlord verification request to update their own
-- row (used to resubmit after a rejection, or to cancel/ignore it). Ops keep
-- their separate update policy; this is additive and scoped strictly to the
-- requesting agent.
CREATE POLICY "Agents can update own verification requests"
ON public.landlord_verification_requests
FOR UPDATE
TO authenticated
USING (auth.uid() = requested_by)
WITH CHECK (auth.uid() = requested_by);