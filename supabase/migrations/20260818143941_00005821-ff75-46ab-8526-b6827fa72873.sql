DO $do$
DECLARE
  d text;
  d2 text;
BEGIN
  d := pg_get_functiondef('public.run_payout_acceptance_checks(integer)'::regprocedure);
  IF position('(tg.tgtype & 8) > 0' IN d) = 0 THEN
    RAISE EXCEPTION 'expected trigger-timing snippet not found';
  END IF;
  d2 := replace(d, '(tg.tgtype & 8) > 0', '(tg.tgtype & 4) > 0');
  d2 := replace(d2, 'AND (tg.tgtype & 4) > 0
      AND (tg.tgtype & 4) > 0', 'AND (tg.tgtype & 2) > 0
      AND (tg.tgtype & 4) > 0');
  IF position('(tg.tgtype & 2) > 0' IN d2) = 0 THEN
    RAISE EXCEPTION 'BEFORE-timing rewrite failed';
  END IF;
  EXECUTE d2;
END
$do$;