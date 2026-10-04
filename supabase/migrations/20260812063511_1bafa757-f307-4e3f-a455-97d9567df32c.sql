CREATE OR REPLACE FUNCTION public.get_active_employee_staff_count()
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT (
    public.has_role(auth.uid(), 'hr'::public.app_role)
    OR public.has_role(auth.uid(), 'manager'::public.app_role)
    OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
    OR public.has_role(auth.uid(), 'ceo'::public.app_role)
    OR public.has_role(auth.uid(), 'coo'::public.app_role)
    OR public.has_role(auth.uid(), 'cto'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized to view active employee staff count';
  END IF;

  RETURN (
    SELECT count(DISTINCT ur.user_id)::bigint
    FROM public.user_roles ur
    WHERE ur.role = 'employee'::public.app_role
      AND ur.enabled IS TRUE
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_active_employee_staff_count() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_active_employee_staff_count() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_active_employee_staff_count() TO service_role;