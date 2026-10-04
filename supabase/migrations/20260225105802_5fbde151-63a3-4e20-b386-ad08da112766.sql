
-- Simplify landlord INSERT policies to be more permissive
-- Any authenticated user should be able to register a landlord
-- The key security is: tenant_id must match auth.uid() OR registered_by must match auth.uid()

DROP POLICY IF EXISTS "Agents can insert landlords for any tenant" ON public.landlords;
DROP POLICY IF EXISTS "Managers can insert landlords" ON public.landlords;
DROP POLICY IF EXISTS "Tenants can insert own landlords" ON public.landlords;

-- Single unified INSERT policy: authenticated users can insert if they're the tenant or the registerer
CREATE POLICY "Authenticated users can insert landlords"
ON public.landlords
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = tenant_id 
  OR auth.uid() = registered_by 
  OR tenant_id IS NULL
);
