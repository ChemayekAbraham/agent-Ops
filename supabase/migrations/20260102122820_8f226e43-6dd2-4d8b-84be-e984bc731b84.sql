-- Add rent_discount_active flag to profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS rent_discount_active boolean NOT NULL DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS monthly_rent numeric;

-- Create tenant ratings table
CREATE TABLE public.tenant_ratings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id uuid NOT NULL,
  landlord_id uuid NOT NULL,
  rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, landlord_id)
);

-- Enable RLS
ALTER TABLE public.tenant_ratings ENABLE ROW LEVEL SECURITY;

-- Policies for tenant_ratings
CREATE POLICY "Landlords can rate their tenants"
ON public.tenant_ratings
FOR INSERT
WITH CHECK (auth.uid() = landlord_id);

CREATE POLICY "Landlords can update their ratings"
ON public.tenant_ratings
FOR UPDATE
USING (auth.uid() = landlord_id);

CREATE POLICY "Landlords can delete their ratings"
ON public.tenant_ratings
FOR DELETE
USING (auth.uid() = landlord_id);

CREATE POLICY "Anyone can view ratings"
ON public.tenant_ratings
FOR SELECT
USING (true);

CREATE POLICY "Managers can view all ratings"
ON public.tenant_ratings
FOR SELECT
USING (has_role(auth.uid(), 'manager'::app_role));

-- Add registered_by to landlords table (for agent/landlord registration)
ALTER TABLE public.landlords ADD COLUMN IF NOT EXISTS registered_by uuid;

-- Allow agents and landlords to register tenants
DROP POLICY IF EXISTS "Tenants can insert landlords" ON public.landlords;
CREATE POLICY "Users can insert landlords"
ON public.landlords
FOR INSERT
WITH CHECK (
  auth.uid() = tenant_id 
  OR has_role(auth.uid(), 'agent'::app_role) 
  OR has_role(auth.uid(), 'landlord'::app_role)
);

-- Create trigger for updated_at on tenant_ratings
CREATE TRIGGER update_tenant_ratings_updated_at
BEFORE UPDATE ON public.tenant_ratings
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();