BEGIN;
SET LOCAL lock_timeout = '5s';
UPDATE public.job_applications
SET archived_at = coalesce(archived_at, purged_at),
    archived_by = coalesce(archived_by, purged_by),
    purged_at = null,
    purged_by = null
WHERE purged_at IS NOT NULL;
COMMIT;