ALTER TABLE public.business_advances
  ADD COLUMN IF NOT EXISTS applicant_latitude NUMERIC,
  ADD COLUMN IF NOT EXISTS applicant_longitude NUMERIC,
  ADD COLUMN IF NOT EXISTS applicant_location_accuracy NUMERIC,
  ADD COLUMN IF NOT EXISTS applicant_location_captured_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS applicant_location_manual TEXT,
  ADD COLUMN IF NOT EXISTS tenant_alternate_phone TEXT,
  ADD COLUMN IF NOT EXISTS next_of_kin_name TEXT,
  ADD COLUMN IF NOT EXISTS next_of_kin_phone TEXT,
  ADD COLUMN IF NOT EXISTS next_of_kin_relationship TEXT,
  ADD COLUMN IF NOT EXISTS guarantor_name TEXT,
  ADD COLUMN IF NOT EXISTS guarantor_phone TEXT;