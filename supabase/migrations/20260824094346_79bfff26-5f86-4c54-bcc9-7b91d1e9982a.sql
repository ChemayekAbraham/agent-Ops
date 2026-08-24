CREATE OR REPLACE FUNCTION public.assert_merchant_float_alloc_access()
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Internal/service execution (cron, edge functions) is always allowed.
  IF current_user IN ('postgres', 'service_role', 'supabase_admin') THEN
    RETURN true;
  END IF;
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF public.has_role(auth.uid(), 'cfo')
     OR public.has_role(auth.uid(), 'financial_ops')
     OR public.has_role(auth.uid(), 'coo')
     OR public.has_role(auth.uid(), 'manager')
     OR public.has_role(auth.uid(), 'super_admin') THEN
    RETURN true;
  END IF;
  RAISE EXCEPTION 'Not authorized: merchant float allocation is restricted to CFO, Financial Ops, COO, manager and super admin';
END;
$$;