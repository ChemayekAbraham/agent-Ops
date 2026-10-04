-- Drop the existing restrictive policy
DROP POLICY IF EXISTS "Users can insert landlords" ON public.landlords;

-- Create a simpler policy that allows authenticated users to insert landlords with their own tenant_id
CREATE POLICY "Authenticated users can insert landlords"
ON public.landlords
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = tenant_id);

-- Also ensure there's a policy for agents inserting landlords
CREATE POLICY "Agents can insert landlords for any tenant"
ON public.landlords
FOR INSERT
TO authenticated
WITH CHECK (has_role(auth.uid(), 'agent'::app_role));

-- Managers should also be able to insert landlords
CREATE POLICY "Managers can insert landlords"
ON public.landlords
FOR INSERT
TO authenticated
WITH CHECK (has_role(auth.uid(), 'manager'::app_role));