ALTER TABLE public.rent_requests DROP CONSTRAINT IF EXISTS rent_requests_duration_days_check;

ALTER TABLE public.rent_requests
  ADD CONSTRAINT rent_requests_duration_days_check
  CHECK (
    duration_days IS NULL
    OR duration_days IN (30, 60, 90, 120)
    OR (duration_days >= 7 AND duration_days <= 364 AND duration_days % 7 = 0)
  );