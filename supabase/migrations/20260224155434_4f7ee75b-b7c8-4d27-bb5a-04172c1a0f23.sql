-- Drop the conflicting policy that requires tenant_id = auth.uid()
-- This policy blocks agent inserts where tenant_id is NULL
DROP POLICY IF EXISTS "Authenticated users can insert landlords" ON public.landlords;

-- Re-create it scoped to tenants only (non-agent, non-manager users inserting their own landlord)
CREATE POLICY "Tenants can insert own landlords"
ON public.landlords
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = tenant_id AND NOT has_role(auth.uid(), 'agent'::app_role) AND NOT has_role(auth.uid(), 'manager'::app_role));