-- Restrict profiles to authenticated users only (remove public access)
DROP POLICY IF EXISTS "Anyone can view profiles" ON public.profiles;

-- Only authenticated users can view profiles
CREATE POLICY "Authenticated users can view profiles"
ON public.profiles FOR SELECT
TO authenticated
USING (true);

-- Add INSERT policy for wallets so new user wallet creation works
CREATE POLICY "Users can create own wallet"
ON public.wallets FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);