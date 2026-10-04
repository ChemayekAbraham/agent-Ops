CREATE OR REPLACE FUNCTION public.acceptance_correction_paths_ungated()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT count(*)::integer
  FROM (VALUES
    ('merchant_float_reconciliations'),
    ('platform_wallet_corrections'),
    ('agent_landlord_float_corrections')
  ) tbls(tbl)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_proc pr ON pr.oid = tg.tgfoid
    WHERE c.relname = tbls.tbl
      AND NOT tg.tgisinternal
      AND (tg.tgtype & 2) > 0   -- BEFORE
      AND (tg.tgtype & 4) > 0   -- INSERT
      AND pr.prosrc ILIKE '%has_role%'
      AND pr.prosrc ILIKE '%auth.uid()%'
  );
$fn$;

REVOKE ALL ON FUNCTION public.acceptance_correction_paths_ungated() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acceptance_correction_paths_ungated() TO service_role;