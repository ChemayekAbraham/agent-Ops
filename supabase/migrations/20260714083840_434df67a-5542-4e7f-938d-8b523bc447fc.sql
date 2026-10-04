DROP POLICY IF EXISTS "Creators can view own landlords" ON public.landlords;
CREATE POLICY "Creators can view own landlords"
ON public.landlords
FOR SELECT
TO authenticated
USING (
  auth.uid() = registered_by
  OR auth.uid() = managed_by_agent_id
  OR auth.uid() = verified_by
);

DROP POLICY IF EXISTS "Creators can view own lc1" ON public.lc1_chairpersons;
CREATE POLICY "Creators can view own lc1"
ON public.lc1_chairpersons
FOR SELECT
TO authenticated
USING (
  auth.uid() = registered_by
);