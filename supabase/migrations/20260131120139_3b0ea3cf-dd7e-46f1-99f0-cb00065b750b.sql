-- Add national_id to profiles for tenant identification
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS national_id TEXT;

-- Add water meter number for NWSC (National Water and Sewerage Corporation)
ALTER TABLE public.landlords ADD COLUMN IF NOT EXISTS water_meter_number TEXT;

-- Add comment for clarity
COMMENT ON COLUMN public.profiles.national_id IS 'National ID number for identity verification';
COMMENT ON COLUMN public.landlords.water_meter_number IS 'NWSC (National Water and Sewerage Corporation) meter number';
COMMENT ON COLUMN public.landlords.electricity_meter_number IS 'UEDCL/UMEME electricity meter number';