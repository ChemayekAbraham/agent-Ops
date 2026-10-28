DO $mig$
DECLARE
  fn text; src text; n int;
  rules text := $r$WHEN g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
                     AND g.description LIKE 'Agent advance%disbursed to wallet%' THEN 'agent'
                WHEN g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
                     AND g.description LIKE 'Partner self-managed funding released to agent landlord float%' THEN 'partner'
                WHEN g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
                     AND g.description LIKE 'Undo of double-reversal:%' THEN 'corrections'
                ELSE cm.k END$r$;
BEGIN
  FOREACH fn IN ARRAY ARRAY['get_cfo_paid_by_category_totals','get_cfo_paid_by_category_page'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO src FROM pg_proc p
     WHERE p.proname = fn AND p.pronamespace = 'public'::regnamespace;
    IF src LIKE '%Undo of double-reversal%' OR src LIKE '%agent_advance_disbursement%' THEN
      RAISE EXCEPTION '% already contains these rules', fn;
    END IF;
    n := (length(src) - length(replace(src, 'ELSE cm.k END', ''))) / length('ELSE cm.k END');
    IF n <> 1 THEN RAISE EXCEPTION '% changed since audit (ELSE count %)', fn, n; END IF;
    IF position('public._cfo_paid_category_for(x.c) AS k' in src) = 0 THEN
      RAISE EXCEPTION '% changed since audit (cm)', fn;
    END IF;
    src := replace(src, 'ELSE cm.k END', rules);
    src := replace(src, 'public._cfo_paid_category_for(x.c) AS k',
      $c$CASE WHEN x.c = 'agent_advance_disbursement' THEN 'agent' ELSE public._cfo_paid_category_for(x.c) END AS k$c$);
    IF fn = 'get_cfo_paid_by_category_totals' THEN
      IF position($t$('rnd', 'Product Research & Development', 8)$t$ in src) = 0 THEN RAISE EXCEPTION 'tiles changed'; END IF;
      src := replace(src, $t$('rnd', 'Product Research & Development', 8)$t$,
        $t$('rnd', 'Product Research & Development', 8),
    ('corrections', 'Corrections', 9)$t$);
    ELSE
      IF position($t$WHEN 'rnd' THEN 'Product Research & Development' END$t$ in src) = 0 THEN RAISE EXCEPTION 'labels changed'; END IF;
      src := replace(src, $t$WHEN 'rnd' THEN 'Product Research & Development' END$t$,
        $t$WHEN 'rnd' THEN 'Product Research & Development' WHEN 'corrections' THEN 'Corrections' END$t$);
    END IF;
    EXECUTE src;
  END LOOP;
END
$mig$;