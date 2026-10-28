-- PENDING — not applied. Reporting-only: Money Out classifies agent bonuses,
-- rewards and commissions recorded as marketing_expense under Agent Products
-- and Services ('agent'). Referral bonuses move only when the recipient holds
-- the agent role. The partner rule stays first, so nothing is counted twice.
-- No ledger, wallet or payment records are touched.
DO $mig$
DECLARE
  v_old constant text := $o$OR g.description LIKE 'Marketing expense: Partner repeat fund-in commission%') THEN 'partner'$o$;
  v_new_rule constant text := $n$OR g.description LIKE 'Marketing expense: Partner repeat fund-in commission%') THEN 'partner'
                WHEN g.category = 'marketing_expense' AND g.ledger_scope = 'platform'
                     AND (g.description ~* '(house-listed reward|listing reward|recruiter override|^Marketing expense: Bonus:|verified bonus|verification bonus|listing bonus|registration bonus|registration verification bo|registration reward|collection streak|commission|^Marketing expense: Sub-agent tenant reward|^Merchant Agent Referral Bonus)'
                          OR (g.description ILIKE 'Referral%'
                              AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = g.user_id AND ur.role = 'agent'))) THEN 'agent'$n$;
  v_fn text; v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.get_cfo_paid_by_category_totals(date,date)',
                              'public.get_cfo_paid_by_category_page(date,date,text,text,integer,integer)'] LOOP
    v_def := pg_get_functiondef(v_fn::regprocedure);
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION 'expected exactly one partner rule in %', v_fn;
    END IF;
    IF position('house-listed reward' in v_def) > 0 THEN
      RAISE EXCEPTION 'agent rule already present in %', v_fn;
    END IF;
    EXECUTE replace(v_def, v_old, v_new_rule);
  END LOOP;
END
$mig$;
