CREATE OR REPLACE FUNCTION public.is_tenant_ops_staff(_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _uid
      AND role IN ('manager','operations','coo','super_admin','ceo','cfo','cto','cmo','crm','employee','hr')
  );
$$;