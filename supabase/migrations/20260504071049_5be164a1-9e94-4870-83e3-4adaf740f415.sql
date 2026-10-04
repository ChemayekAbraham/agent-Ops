ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS preferred_language text;

ALTER TABLE public.rent_requests
  DROP CONSTRAINT IF EXISTS rent_requests_preferred_language_check;

ALTER TABLE public.rent_requests
  ADD CONSTRAINT rent_requests_preferred_language_check
  CHECK (
    preferred_language IS NULL
    OR preferred_language IN ('English','Luganda','Runyankole','Lusoga','Acholi','Lugbara','Other')
  );

COMMENT ON COLUMN public.rent_requests.preferred_language
  IS 'Tenant preferred communication language captured at rent request creation.';