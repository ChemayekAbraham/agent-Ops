-- Add house_category column to rent_requests
ALTER TABLE public.rent_requests 
ADD COLUMN IF NOT EXISTS house_category TEXT;

-- Add a comment for documentation
COMMENT ON COLUMN public.rent_requests.house_category IS 'Housing tier classification e.g. single-room, 1-bed, 2-bed, etc.';