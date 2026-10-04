-- Add location coordinates to landlords table (for tenant house location captured during registration)
ALTER TABLE public.landlords 
ADD COLUMN latitude DECIMAL(10, 8),
ADD COLUMN longitude DECIMAL(11, 8),
ADD COLUMN location_captured_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN location_captured_by UUID REFERENCES auth.users(id);

-- Add comment explaining the purpose
COMMENT ON COLUMN public.landlords.latitude IS 'GPS latitude of tenant house - captured when agent registers landlord';
COMMENT ON COLUMN public.landlords.longitude IS 'GPS longitude of tenant house - captured when agent registers landlord';
COMMENT ON COLUMN public.landlords.location_captured_at IS 'When the location was captured';
COMMENT ON COLUMN public.landlords.location_captured_by IS 'Agent who captured the location';