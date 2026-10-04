CREATE OR REPLACE FUNCTION public.get_landlord_verification_status(p_id uuid)
RETURNS TABLE(exists_flag boolean, verified boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (l.id IS NOT NULL) AS exists_flag,
    COALESCE(l.verified, false) AS verified
  FROM public.landlords l
  WHERE l.id = p_id
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_landlord_verification_status(uuid) TO authenticated, anon, service_role;