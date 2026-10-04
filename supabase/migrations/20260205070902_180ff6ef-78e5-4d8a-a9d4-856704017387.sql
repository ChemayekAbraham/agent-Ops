-- Add location fields to supporter_invites table to store landlord location during registration
ALTER TABLE public.supporter_invites 
ADD COLUMN latitude DECIMAL(10, 8),
ADD COLUMN longitude DECIMAL(11, 8),
ADD COLUMN location_accuracy REAL,
ADD COLUMN property_address TEXT;

COMMENT ON COLUMN public.supporter_invites.latitude IS 'GPS latitude captured during landlord registration (tenant house location)';
COMMENT ON COLUMN public.supporter_invites.longitude IS 'GPS longitude captured during landlord registration (tenant house location)';
COMMENT ON COLUMN public.supporter_invites.location_accuracy IS 'GPS accuracy in meters';
COMMENT ON COLUMN public.supporter_invites.property_address IS 'Property address for landlord registrations';