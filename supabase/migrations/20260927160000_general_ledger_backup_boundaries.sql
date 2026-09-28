-- Page boundaries for the dedicated general_ledger backup (edge function
-- general-ledger-backup). PostgREST caps every response at 1000 rows, which is
-- why weekly-database-backup has only ever captured the first 1000 rows of each
-- table. The backup instead pages the ledger by primary key, id > prev AND
-- id <= next, using the ids at every p_step-th position returned here, and pages
-- in parallel without having to parse the last id out of each CSV page.
--
-- Returns {"total": <rows at snapshot>, "boundaries": [uuid, ...]}. Read-only;
-- service_role only.
CREATE OR REPLACE FUNCTION public.general_ledger_backup_boundaries(p_step integer DEFAULT 900)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM public.general_ledger),
    'boundaries', COALESCE((
      SELECT jsonb_agg(id ORDER BY id)
      FROM (
        SELECT id, row_number() OVER (ORDER BY id) AS rn
        FROM public.general_ledger
      ) s
      WHERE rn % GREATEST(p_step, 1) = 0
    ), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.general_ledger_backup_boundaries(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.general_ledger_backup_boundaries(integer) TO service_role;

-- backup_runs now holds two kinds of run. resend-database-backup-link picks the
-- latest successful row, so it must be able to tell a full-database run from a
-- ledger-only one.
ALTER TABLE public.backup_runs
  ADD COLUMN IF NOT EXISTS backup_kind text NOT NULL DEFAULT 'full_database';
