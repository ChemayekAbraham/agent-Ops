CREATE POLICY "CFO can view all profiles"
ON public.profiles FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'cfo'::app_role));