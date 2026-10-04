DROP POLICY IF EXISTS "Users can create their own withdrawal requests" ON public.withdrawal_requests;

CREATE POLICY "Users can create their own withdrawal requests"
ON public.withdrawal_requests
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);