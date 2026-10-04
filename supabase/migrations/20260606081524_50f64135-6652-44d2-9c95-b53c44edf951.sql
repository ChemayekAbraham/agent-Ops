-- Authoritative server-side check used by the client immediately before
-- creating a rent request. SECURITY DEFINER so it bypasses RLS and returns a
-- trustworthy answer regardless of the caller's read policies. This complements
-- the BEFORE INSERT trigger by giving the agent a clear pre-submit verdict.
CREATE OR REPLACE FUNCTION public.verify_landlord_registered(p_landlord_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.landlords l WHERE l.id = p_landlord_id
  );
$$;

GRANT EXECUTE ON FUNCTION public.verify_landlord_registered(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_landlord_registered(uuid) TO service_role;