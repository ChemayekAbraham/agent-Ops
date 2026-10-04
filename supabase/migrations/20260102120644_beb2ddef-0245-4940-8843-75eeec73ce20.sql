-- Add DELETE policy for landlords table so tenants can remove their own landlords
CREATE POLICY "Tenants can delete own landlords" 
ON public.landlords 
FOR DELETE 
USING (auth.uid() = tenant_id);