-- Allow authenticated users to insert their own roles
CREATE POLICY "Users can insert own roles"
ON public.user_roles
FOR INSERT
WITH CHECK (auth.uid() = user_id);