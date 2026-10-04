BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.job_applications
  ADD COLUMN IF NOT EXISTS public_ref text;

WITH numbered AS (
  SELECT id,
         'WEL-2026-' || lpad((row_number() OVER (ORDER BY created_at ASC))::text, 4, '0') AS ref
    FROM public.job_applications
)
UPDATE public.job_applications j
   SET public_ref = n.ref
  FROM numbered n
 WHERE j.id = n.id
   AND j.public_ref IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS job_applications_public_ref_key
  ON public.job_applications (public_ref);

GRANT INSERT (public_ref) ON public.job_applications TO anon;

COMMIT;