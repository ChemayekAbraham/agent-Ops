-- Fix: Tenant INSERT policy blocks all users because everyone has the 'agent' role.
-- The old policy had: (auth.uid() = tenant_id) AND NOT has_role('agent') AND NOT has_role('manager')
-- Since ALL users get 'agent' role auto-assigned, this always evaluates to false.
-- Replace with a simpler policy that allows inserting when tenant_id matches the user.

DROP POLICY IF EXISTS "Tenants can insert own landlords" ON public.landlords;

CREATE POLICY "Tenants can insert own landlords"
ON public.landlords
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = tenant_id);