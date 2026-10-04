DO $mig$
DECLARE d text; o text := 'rr.daily_repayment, rr.duration_days,
'; n text := 'rr.daily_repayment, rr.duration_days, coalesce(rr.repayment_frequency,''daily'') AS repayment_frequency,
';
BEGIN
  d := pg_get_functiondef('public.crm_callee_dossier(uuid)'::regprocedure);
  IF position('AS repayment_frequency' IN d) > 0 THEN RETURN; END IF;
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'crm_callee_dossier: anchor not found exactly once'; END IF;
  EXECUTE replace(d, o, n);
END $mig$;
REVOKE ALL ON FUNCTION public.crm_callee_dossier(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_callee_dossier(uuid) TO authenticated;