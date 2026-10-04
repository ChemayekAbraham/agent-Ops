BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.job_applications ADD COLUMN IF NOT EXISTS purged_by uuid;
COMMIT;