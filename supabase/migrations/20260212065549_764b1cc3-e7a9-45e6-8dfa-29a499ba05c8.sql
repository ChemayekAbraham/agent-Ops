
-- Add location columns to rent_requests for GPS capture at submission time
ALTER TABLE public.rent_requests 
  ADD COLUMN IF NOT EXISTS request_latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS request_longitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS request_city TEXT,
  ADD COLUMN IF NOT EXISTS request_country TEXT;
