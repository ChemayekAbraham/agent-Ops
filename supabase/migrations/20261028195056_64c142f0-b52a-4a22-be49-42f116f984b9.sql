DO $mig$
DECLARE
  v_rule constant text := $r$WHEN g.category = 'marketing_expense' AND g.ledger_scope = 'platform'
                     AND (g.description LIKE 'Marketing expense: Promissory partner top-up commission%'
                          OR g.description LIKE 'Marketing expense: Promissory partner portfolio commission%'
                          OR g.description LIKE 'Marketing expense: Verified promissory note bonus%'
                          OR g.description = 'Marketing expense: lead partner growth override') THEN 'partner'
                ELSE cm.k END$r$;
  v_fn text; v_def text; v_new text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.get_cfo_paid_by_category_totals(date,date)',
                              'public.get_cfo_paid_by_category_page(date,date,text,text,integer,integer)'] LOOP
    v_def := pg_get_functiondef(v_fn::regprocedure);
    IF (length(v_def) - length(replace(v_def, 'ELSE cm.k END', ''))) / length('ELSE cm.k END') <> 1 THEN
      RAISE EXCEPTION 'expected exactly one category fallback in %', v_fn;
    END IF;
    IF position('Promissory partner top-up' in v_def) > 0 THEN
      RAISE EXCEPTION 'rule already present in %', v_fn;
    END IF;
    v_new := replace(v_def, 'ELSE cm.k END', v_rule);
    EXECUTE v_new;
  END LOOP;
END
$mig$;