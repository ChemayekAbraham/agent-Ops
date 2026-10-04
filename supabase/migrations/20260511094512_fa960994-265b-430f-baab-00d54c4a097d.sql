-- 1. New column: grace days before arrears auto-charge begins
ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS outstanding_grace_days INTEGER;

COMMENT ON COLUMN public.rent_requests.outstanding_grace_days IS
  'For outstanding-balance registrations: days left on tenant''s current rent period. Auto-charge engine defers the first arrears charge until today + outstanding_grace_days. NULL = no grace (charge starts next day).';

-- 2. Backfill from the legacy "[DAYS_REMAINING:N]" prefix in landlord_call_notes
UPDATE public.rent_requests
SET outstanding_grace_days = NULLIF(
      (regexp_match(landlord_call_notes, '\[DAYS_REMAINING:(\d+)\]'))[1],
      ''
    )::int
WHERE outstanding_grace_days IS NULL
  AND landlord_call_notes ~ '\[DAYS_REMAINING:\d+\]';

-- Strip the prefix from notes once promoted (leave any other note text intact)
UPDATE public.rent_requests
SET landlord_call_notes = NULLIF(
      btrim(regexp_replace(landlord_call_notes, '\[DAYS_REMAINING:\d+\]', '', 'g')),
      ''
    )
WHERE landlord_call_notes ~ '\[DAYS_REMAINING:\d+\]';

-- 3. Helper index for the auto-charge engine / pipeline scans
CREATE INDEX IF NOT EXISTS idx_rent_requests_outstanding_grace
  ON public.rent_requests (registration_type, outstanding_grace_days)
  WHERE registration_type = 'outstanding_balance';