BEGIN;
SET LOCAL lock_timeout = '5s';
UPDATE public.job_applications
SET purged_at = null,
    purged_by = null
WHERE archived_at IS NOT NULL
  AND purged_at IS NOT NULL;
COMMIT;