CREATE OR REPLACE FUNCTION public.landlord_ops_principal_recovered()
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public._has_enabled_role(auth.uid(), ARRAY['landlord_ops','cfo','ceo','coo','manager','financial_ops','super_admin','cto']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  -- Principal component only (fees, Returns, commission excluded by column); reversed splits excluded;
  -- one row per (plan, source) by unique index, so no double counting.
  RETURN (SELECT COALESCE(SUM(principal_component),0) FROM public.instalment_allocations WHERE reversed_at IS NULL);
END $$;
REVOKE ALL ON FUNCTION public.landlord_ops_principal_recovered() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.landlord_ops_principal_recovered() TO authenticated;