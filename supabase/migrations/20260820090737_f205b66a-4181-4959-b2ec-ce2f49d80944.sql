CREATE OR REPLACE FUNCTION public.psm_is_topup_reviewer(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_uid IS NOT NULL AND (
    public.is_ops_role(p_uid)
    OR public.is_partner_ops(p_uid)
    OR public.has_role(p_uid, 'cfo'::app_role)
    OR public.has_role(p_uid, 'coo'::app_role)
    OR public.has_role(p_uid, 'ceo'::app_role)
    OR public.has_role(p_uid, 'manager'::app_role)
    OR public.has_role(p_uid, 'super_admin'::app_role)
  );
$$;