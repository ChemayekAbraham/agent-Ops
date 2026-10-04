ALTER TABLE public.business_advances
  ADD COLUMN IF NOT EXISTS location_history JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.business_advances.location_history IS
  'Append-only audit trail of GPS captures, reverse-geocode results, and manual edits to applicant/business location during the request flow. Each entry: { ts, event, source, field?, lat?, lng?, accuracy?, address?, previous?, value? }';
