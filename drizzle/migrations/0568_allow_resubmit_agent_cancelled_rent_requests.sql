DO $mig$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('public.agent_resubmit_rent_request(uuid,jsonb,text)'::regprocedure);
  n := replace(d, $q$IF _row.status <> 'rejected'$q$, $q$IF _row.status NOT IN ('rejected', 'deleted_by_agent')$q$);
  n := replace(n, $q$'Only rejected or recalled requests can be resubmitted$q$, $q$'Only rejected, agent-cancelled or recalled requests can be resubmitted$q$);
  IF n = d THEN RAISE EXCEPTION 'agent_resubmit_rent_request body changed; patch not applied'; END IF;
  EXECUTE n;
END
$mig$;