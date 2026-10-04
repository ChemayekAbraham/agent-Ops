BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.job_applications ADD COLUMN archived_at timestamptz;

ALTER TABLE public.job_applications ADD COLUMN archived_by uuid;

UPDATE public.job_applications
SET archived_at = purged_at,
    archived_by = purged_by
WHERE purged_at IS NOT NULL;

COMMIT;