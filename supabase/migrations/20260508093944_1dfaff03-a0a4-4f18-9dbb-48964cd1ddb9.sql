ALTER TABLE public.rent_requests
DROP CONSTRAINT IF EXISTS rent_requests_duration_days_check;

ALTER TABLE public.rent_requests
ADD CONSTRAINT rent_requests_duration_days_check
CHECK (duration_days = ANY (ARRAY[7, 14, 21, 30, 60, 90, 120]));