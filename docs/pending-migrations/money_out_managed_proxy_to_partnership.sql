-- PENDING — not applied. Reporting-only: Money Out classifies managed proxy
-- portfolio activation (2%) and top-up (1%) commissions under Partnership
-- Products and Services instead of Marketing. No ledger, wallet or payment
-- records are touched; only the two report functions are redefined.
DO $mig$
DECLARE
  v_old constant text := $o$OR g.description = 'Marketing expense: lead partner growth override') THEN 'partner'$o$;
  v_new_rule constant text := $n$OR g.description = 'Marketing expense: lead partner growth override'
                          OR g.description LIKE 'Marketing expense: Managed proxy portfolio activation commission%'
                          OR g.description LIKE 'Marketing expense: Managed proxy portfolio top-up commission%') THEN 'partner'$n$;
  v_fn text; v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.get_cfo_paid_by_category_totals(date,date)',
                              'public.get_cfo_paid_by_category_page(date,date,text,text,integer,integer)'] LOOP
    v_def := pg_get_functiondef(v_fn::regprocedure);
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION 'expected exactly one partner rule in %', v_fn;
    END IF;
    IF position('Managed proxy portfolio' in v_def) > 0 THEN
      RAISE EXCEPTION 'managed proxy rule already present in %', v_fn;
    END IF;
    EXECUTE replace(v_def, v_old, v_new_rule);
  END LOOP;
END
$mig$;
