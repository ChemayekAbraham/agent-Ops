BEGIN;

SET LOCAL lock_timeout = '5s';

-- A. Column
ALTER TABLE public.internship_applications
  ADD COLUMN IF NOT EXISTS public_ref text;

-- B. Unique index
CREATE UNIQUE INDEX IF NOT EXISTS internship_applications_public_ref_key
  ON public.internship_applications (public_ref);

-- C. Backfill from own id
UPDATE public.internship_applications
SET public_ref = upper(substr(replace(id::text, '-', ''), 1, 8))
WHERE public_ref IS NULL;

-- D. Replica identity
ALTER TABLE public.internship_applications REPLICA IDENTITY FULL;

-- E. Publication membership (skip if already present)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'internship_applications'
     )
  THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.internship_applications';
  END IF;
END $$;

COMMIT;