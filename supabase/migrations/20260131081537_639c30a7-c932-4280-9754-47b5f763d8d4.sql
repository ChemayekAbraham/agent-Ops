-- Add new columns to landlords table for enhanced registration
ALTER TABLE public.landlords 
ADD COLUMN IF NOT EXISTS has_smartphone boolean DEFAULT true,
ADD COLUMN IF NOT EXISTS electricity_meter_number text,
ADD COLUMN IF NOT EXISTS number_of_houses integer DEFAULT 1,
ADD COLUMN IF NOT EXISTS desired_rent_from_welile numeric,
ADD COLUMN IF NOT EXISTS caretaker_name text,
ADD COLUMN IF NOT EXISTS caretaker_phone text;

-- Add comment for clarity
COMMENT ON COLUMN public.landlords.has_smartphone IS 'Whether the landlord has a smartphone';
COMMENT ON COLUMN public.landlords.electricity_meter_number IS 'Electricity meter number for the property';
COMMENT ON COLUMN public.landlords.number_of_houses IS 'Number of houses the landlord owns';
COMMENT ON COLUMN public.landlords.desired_rent_from_welile IS 'Amount landlord wants to receive from Welile';
COMMENT ON COLUMN public.landlords.caretaker_name IS 'Name of the property caretaker if any';
COMMENT ON COLUMN public.landlords.caretaker_phone IS 'Phone number of the caretaker';