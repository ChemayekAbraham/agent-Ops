
-- 1. FIX: user_roles privilege escalation - remove self-assignment
DROP POLICY IF EXISTS "Users or managers can insert roles" ON public.user_roles;
CREATE POLICY "Only managers can insert roles"
ON public.user_roles FOR INSERT TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
);

-- 2. FIX: supporter_invites plaintext password exposure
DROP POLICY IF EXISTS "Anyone can read invite by activation token" ON public.supporter_invites;

-- Create secure RPC to look up invite by token (no temp_password exposed)
CREATE OR REPLACE FUNCTION public.lookup_invite_by_token(p_token text)
RETURNS TABLE(
  full_name text,
  status text,
  role text,
  email text,
  phone text,
  activated_user_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT si.full_name, si.status, si.role, si.email, si.phone, si.activated_user_id
  FROM public.supporter_invites si
  WHERE si.activation_token = p_token::uuid
  LIMIT 1;
$$;

-- 3. FIX: credit_access_limits - restrict to owner or staff
DROP POLICY IF EXISTS "Anyone authenticated can view credit limits" ON public.credit_access_limits;
CREATE POLICY "Users view own credit limits or staff view all"
ON public.credit_access_limits FOR SELECT TO authenticated
USING (
  auth.uid() = user_id
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
  OR public.has_role(auth.uid(), 'ceo'::app_role)
);
