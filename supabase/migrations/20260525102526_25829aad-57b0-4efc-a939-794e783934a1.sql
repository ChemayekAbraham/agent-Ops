ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS latest_rent_receipt_url TEXT,
  ADD COLUMN IF NOT EXISTS latest_rent_receipt_uploaded_at TIMESTAMPTZ;