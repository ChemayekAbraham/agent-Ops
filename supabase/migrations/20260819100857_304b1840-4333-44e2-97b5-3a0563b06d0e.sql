BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.job_applications
  ADD COLUMN IF NOT EXISTS shortlist_round smallint;

ALTER TABLE public.job_applications
  DROP CONSTRAINT IF EXISTS job_applications_shortlist_round_check;

ALTER TABLE public.job_applications
  ADD CONSTRAINT job_applications_shortlist_round_check
  CHECK (shortlist_round IS NULL OR (shortlist_round >= 1 AND shortlist_round <= 3));

UPDATE public.job_applications
SET shortlist_round = 1
WHERE status = 'shortlisted'
  AND shortlist_round IS NULL;

COMMIT;