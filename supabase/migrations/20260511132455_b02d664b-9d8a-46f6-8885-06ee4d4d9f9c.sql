ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS resubmitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS resubmitted_note text;