DROP POLICY IF EXISTS "Authenticated users can insert landlords" ON public.landlords;

CREATE POLICY "Authenticated users can insert landlords"
ON public.landlords
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = registered_by
  OR auth.uid() = tenant_id
);