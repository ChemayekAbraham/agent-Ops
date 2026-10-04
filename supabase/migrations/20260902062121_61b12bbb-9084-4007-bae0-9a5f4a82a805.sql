-- Prevent agents from self-approving their own landlord verification requests.
-- Agents may still cancel a pending request or resubmit a rejected request to pending,
-- but they can never change the status to 'verified' (or 'rejected').
DROP POLICY IF EXISTS "Agents can update own verification requests" ON public.landlord_verification_requests;

CREATE POLICY "Agents can update own verification requests"
ON public.landlord_verification_requests
FOR UPDATE
TO authenticated
USING (
  auth.uid() = requested_by
  AND status IN ('pending', 'rejected')
)
WITH CHECK (
  auth.uid() = requested_by
  AND status IN ('pending', 'cancelled')
);