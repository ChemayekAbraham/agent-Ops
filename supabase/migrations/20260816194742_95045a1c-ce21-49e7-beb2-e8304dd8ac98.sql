BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.job_applications
ALTER COLUMN public_ref
SET DEFAULT UPPER(LEFT(REPLACE(gen_random_uuid()::text, '-', ''), 8));

UPDATE public.job_applications
SET public_ref = UPPER(LEFT(REPLACE(gen_random_uuid()::text, '-', ''), 8))
WHERE public_ref IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS job_applications_public_ref_key
ON public.job_applications (public_ref);

COMMIT;