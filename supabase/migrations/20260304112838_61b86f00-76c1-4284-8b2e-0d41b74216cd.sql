CREATE POLICY "Anyone can read invite by activation token"
ON public.supporter_invites
FOR SELECT
TO anon, authenticated
USING (true);