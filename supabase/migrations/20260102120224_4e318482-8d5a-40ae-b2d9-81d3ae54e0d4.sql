-- Add tenant_id and monthly_rent to landlords table for tenant-landlord relationship
ALTER TABLE public.landlords 
ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES auth.users(id),
ADD COLUMN IF NOT EXISTS monthly_rent numeric;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_landlords_tenant_id ON public.landlords(tenant_id);

-- Add RLS policy for tenants to view their own landlords
CREATE POLICY "Tenants can view own landlords" 
ON public.landlords 
FOR SELECT 
USING (auth.uid() = tenant_id);

-- Add RLS policy for tenants to update their own landlords
CREATE POLICY "Tenants can update own landlords" 
ON public.landlords 
FOR UPDATE 
USING (auth.uid() = tenant_id);