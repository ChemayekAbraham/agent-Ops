DO $mig$
DECLARE d text; o text; n text;
BEGIN
  d := pg_get_functiondef('public._cfo_paid_lunch_correction_ok(uuid,uuid,numeric,timestamptz)'::regprocedure);
  o := $x$(o.transaction_date AT TIME ZONE 'Africa/Kampala')::date = (p_ts AT TIME ZONE 'Africa/Kampala')::date$x$;
  n := $x$o.transaction_date >= (((p_ts AT TIME ZONE 'Africa/Kampala')::date)::timestamp AT TIME ZONE 'Africa/Kampala')
          AND o.transaction_date < ((((p_ts AT TIME ZONE 'Africa/Kampala')::date + 1))::timestamp AT TIME ZONE 'Africa/Kampala')$x$;
  IF strpos(d, o) = 0 THEN RAISE EXCEPTION 'lunch helper text changed'; END IF;
  EXECUTE replace(d, o, n);

  d := pg_get_functiondef('public.get_cfo_paid_by_category_totals(date,date)'::regprocedure);
  o := $x$AND (g.transaction_date AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to$x$;
  n := $x$AND g.transaction_date >= (p_from::timestamp AT TIME ZONE 'Africa/Kampala')
      AND g.transaction_date < ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala')$x$;
  IF strpos(d, o) = 0 THEN RAISE EXCEPTION 'totals text changed'; END IF;
  EXECUTE replace(d, o, n);
END
$mig$;