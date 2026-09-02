CREATE OR REPLACE FUNCTION public.manager_vendor_pin_flags()
RETURNS TABLE(vendor_id uuid, has_pin boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT v.id, (v.pin_hash IS NOT NULL)
  FROM public.vendors v
  WHERE public.has_role(auth.uid(), 'manager');
$$;
