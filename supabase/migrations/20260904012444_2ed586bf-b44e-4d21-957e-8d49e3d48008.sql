DO $do$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='tppo_projection_zone_a';

  d := replace(d,
    'when ''week''  then (date_trunc(''week'', v_start::timestamp) + ((i - 1) * interval ''7 days''))::date',
    'when ''week''  then ((select b.period_start from public.tppo_period_bounds(''week'', v_start) b) + ((i - 1) * 7))::date');
  d := replace(d,
    'when ''week''  then (date_trunc(''week'', v_start::timestamp) + ((i - 1) * interval ''7 days'') + interval ''6 days'')::date',
    'when ''week''  then ((select b.period_start from public.tppo_period_bounds(''week'', v_start) b) + ((i - 1) * 7) + 6)::date');

  IF d ILIKE '%date_trunc(''week''%' THEN
    RAISE EXCEPTION 'week expression not replaced';
  END IF;

  EXECUTE d;
END
$do$;