ALTER TABLE public.rent_requests
  ADD COLUMN registration_type TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN initial_outstanding_balance NUMERIC DEFAULT 0;