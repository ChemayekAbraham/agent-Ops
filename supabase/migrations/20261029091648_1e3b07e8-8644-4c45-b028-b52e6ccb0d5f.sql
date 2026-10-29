DO $$
DECLARE f text; d text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.get_cfo_paid_by_category_totals(date,date)','public.get_cfo_paid_by_category_page(date,date,text,text,integer,integer)'] LOOP
    d := pg_get_functiondef(f::regprocedure);
    d := replace(d, $q$CASE WHEN g.classification = 'admin_correction' THEN 'budget'$q$,
      $q$CASE WHEN g.classification = 'admin_correction' OR (g.category = 'payroll_expense' AND g.ledger_scope = 'platform' AND g.description ILIKE '%lunch allowance%') THEN 'lunch'$q$);
    d := replace(d, 'ELSE cm.k END', $q$ELSE CASE WHEN cm.k = 'budget' THEN 'operational' ELSE cm.k END END$q$);
    EXECUTE d;
  END LOOP;
END $$;