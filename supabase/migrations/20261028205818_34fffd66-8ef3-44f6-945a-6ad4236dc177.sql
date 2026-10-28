DO $mig$
DECLARE
  v_old constant text := $o$OR g.description LIKE 'Marketing expense: Partner repeat fund-in commission%') THEN 'partner'$o$;
  v_new_rule constant text := $n$OR g.description LIKE 'Marketing expense: Partner repeat fund-in commission%') THEN 'partner'
                WHEN g.category = 'marketing_expense' AND g.ledger_scope = 'platform'
                     AND (g.description LIKE 'Platform expense: instant house-listed reward%'
                          OR g.description LIKE 'Platform expense: listing reward%'
                          OR g.description LIKE '%recruiter override%'
                          OR g.description LIKE 'Marketing expense: Bonus:%'
                          OR g.description LIKE '%verified bonus%'
                          OR g.description LIKE '%verification bonus%'
                          OR g.description LIKE 'Marketing expense: listing bonus%'
                          OR g.description LIKE '%registration bonus%'
                          OR g.description LIKE '%registration verification bo%'
                          OR g.description LIKE 'Platform expense: instant LC%-registration reward%'
                          OR g.description LIKE 'Marketing expense: Weekly Collection Streak reward%'
                          OR g.description LIKE '%agent commission for landlord payout%'
                          OR g.description LIKE 'Commission restore offset%'
                          OR g.description LIKE 'Marketing expense: commission correction%'
                          OR g.description LIKE 'Marketing expense: agent commission backfill%'
                          OR g.description LIKE 'Marketing expense: Manager agent commission%'
                          OR g.description LIKE 'Marketing expense: Sub-agent tenant reward%'
                          OR g.description LIKE 'Merchant Agent Referral Bonus%'
                          OR (g.description LIKE 'Referral%'
                              AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = g.user_id AND ur.role = 'agent'))) THEN 'agent'$n$;
  v_fn text; v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.get_cfo_paid_by_category_totals(date,date)',
                              'public.get_cfo_paid_by_category_page(date,date,text,text,integer,integer)'] LOOP
    v_def := pg_get_functiondef(v_fn::regprocedure);
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION 'expected exactly one partner rule in %', v_fn;
    END IF;
    IF position('instant house-listed reward' in v_def) > 0 THEN
      RAISE EXCEPTION 'agent rule already present in %', v_fn;
    END IF;
    EXECUTE replace(v_def, v_old, v_new_rule);
  END LOOP;
END
$mig$;