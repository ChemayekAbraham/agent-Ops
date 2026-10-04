
ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS collection_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS collection_locked_reason text,
  ADD COLUMN IF NOT EXISTS collection_lock_days integer;

CREATE INDEX IF NOT EXISTS idx_rent_requests_collection_locked_at
  ON public.rent_requests (collection_locked_at)
  WHERE collection_locked_at IS NOT NULL;
