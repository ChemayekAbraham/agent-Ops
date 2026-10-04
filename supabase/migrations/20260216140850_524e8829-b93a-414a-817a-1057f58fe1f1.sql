
-- Fix 1: Replace blanket SELECT policies on profiles with role-scoped access
DROP POLICY IF EXISTS "Authenticated users can view all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Authenticated users can view profiles" ON public.profiles;

-- Users can always view their own profile
CREATE POLICY "Users can view own profile"
ON public.profiles FOR SELECT
USING (auth.uid() = id);

-- Managers can view all profiles (needed for user management)
CREATE POLICY "Managers can view all profiles"
ON public.profiles FOR SELECT
USING (has_role(auth.uid(), 'manager'::app_role));

-- Agents can view profiles (needed for tenant management, referrals, subagents)
CREATE POLICY "Agents can view all profiles"
ON public.profiles FOR SELECT
USING (has_role(auth.uid(), 'agent'::app_role));

-- Supporters can view profiles (needed for rent request funding)
CREATE POLICY "Supporters can view all profiles"
ON public.profiles FOR SELECT
USING (is_supporter());

-- Fix 2: Add DELETE policy for managers
CREATE POLICY "Managers can delete profiles"
ON public.profiles FOR DELETE
USING (has_role(auth.uid(), 'manager'::app_role));
