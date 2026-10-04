CREATE OR REPLACE FUNCTION public.is_partner_ops(_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _uid
      AND role::text IN ('manager','coo','super_admin','cto','partner_ops','ceo','director')
  ) OR EXISTS (
    SELECT 1 FROM public.staff_permissions
    WHERE user_id = _uid AND permitted_dashboard = 'partner-ops'
  );
$$;