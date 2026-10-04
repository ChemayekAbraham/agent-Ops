
-- Fix the RPC with proper UUID cast
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
