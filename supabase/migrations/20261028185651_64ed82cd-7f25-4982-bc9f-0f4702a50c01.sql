DO $mig$
DECLARE d text; o1 text; o2 text; o3 text;
BEGIN
  -- Totals
  d := pg_get_functiondef('public.get_cfo_paid_by_category_totals(date,date)'::regprocedure);
  o1 := 'WITH legs AS (';
  o2 := 'ELSE public._cfo_paid_category_for(g.category) END AS cat_key';
  o3 := $x$FROM public.general_ledger g
    WHERE g.direction = 'cash_out'$x$;
  IF strpos(d,o1)=0 OR strpos(d,o2)=0 OR strpos(d,o3)=0 THEN RAISE EXCEPTION 'totals text changed'; END IF;
  d := replace(d, o1, $x$WITH cm AS MATERIALIZED (
    SELECT x.c, public._cfo_paid_category_for(x.c) AS k
    FROM (SELECT DISTINCT g0.category AS c FROM public.general_ledger g0
          WHERE g0.direction = 'cash_out'
            AND g0.transaction_date >= (p_from::timestamp AT TIME ZONE 'Africa/Kampala')
            AND g0.transaction_date < ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala')) x
  ), legs AS ($x$);
  d := replace(d, o2, 'ELSE cm.k END AS cat_key');
  d := replace(d, o3, $x$FROM public.general_ledger g
    LEFT JOIN cm ON cm.c = g.category
    WHERE g.direction = 'cash_out'$x$);
  EXECUTE d;

  -- Page
  d := pg_get_functiondef('public.get_cfo_paid_by_category_page(date,date,text,text,integer,integer)'::regprocedure);
  o1 := 'WITH f AS (';
  o2 := 'ELSE public._cfo_paid_category_for(g.category) END AS ckey';
  o3 := 'LEFT JOIN public.profiles sp ON v_search IS NOT NULL AND sp.id = g.user_id';
  IF strpos(d,o1)=0 OR strpos(d,o2)=0 OR strpos(d,o3)=0 THEN RAISE EXCEPTION 'page text changed'; END IF;
  d := replace(d, o1, $x$WITH cm AS MATERIALIZED (
    SELECT x.c, public._cfo_paid_category_for(x.c) AS k
    FROM (SELECT DISTINCT g0.category AS c FROM public.general_ledger g0
          WHERE g0.direction = 'cash_out' AND g0.transaction_date >= v_from AND g0.transaction_date < v_to) x
  ), f AS ($x$);
  d := replace(d, o2, 'ELSE cm.k END AS ckey');
  d := replace(d, o3, o3 || E'\n    LEFT JOIN cm ON cm.c = g.category');
  EXECUTE d;
END
$mig$;