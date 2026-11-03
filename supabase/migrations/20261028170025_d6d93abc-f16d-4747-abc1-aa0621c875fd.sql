DO $migration$
DECLARE
  v_map text;
  v_totals text;
  v_page text;
  v_category text;
BEGIN
  SELECT pg_get_functiondef('public._cfo_paid_category_for(text)'::regprocedure) INTO v_map;
  FOREACH v_category IN ARRAY ARRAY['rent_disbursement','landlord_pool_deploy_company_managed','landlord_pool_release_company_managed','landlord_pool_release_self_support'] LOOP
    IF strpos(v_map, format('WHEN %L THEN %L', v_category, 'landlord_float')) = 0 THEN
      RAISE EXCEPTION 'Unexpected current landlord mapping for %', v_category;
    END IF;
    v_map := replace(v_map, format('WHEN %L THEN %L', v_category, 'landlord_float'), format('WHEN %L THEN %L', v_category, 'landlord'));
  END LOOP;
  v_map := replace(v_map, 'IMMUTABLE', 'IMMUTABLE' || chr(10) || ' SET search_path TO ''public''');
  EXECUTE v_map;

  SELECT pg_get_functiondef('public.get_cfo_paid_by_category_totals(date,date)'::regprocedure) INTO v_totals;
  IF strpos(v_totals, '(''landlord_float'', ''Landlord Float'', 2),') = 0 THEN
    RAISE EXCEPTION 'Unexpected current Money Out category list';
  END IF;
  v_totals := replace(v_totals, '(''landlord_float'', ''Landlord Float'', 2),', '');
  EXECUTE v_totals;

  SELECT pg_get_functiondef('public.get_cfo_paid_by_category_page(date,date,text,text,integer,integer)'::regprocedure) INTO v_page;
  IF strpos(v_page, 'WHEN ''landlord_float'' THEN ''Landlord Float''') = 0 THEN
    RAISE EXCEPTION 'Unexpected current Money Out category labels';
  END IF;
  v_page := replace(v_page, 'WHEN ''landlord_float'' THEN ''Landlord Float''', '');
  EXECUTE v_page;

  FOREACH v_category IN ARRAY ARRAY['rent_disbursement','landlord_pool_deploy_company_managed','landlord_pool_release_company_managed','landlord_pool_release_self_support','agent_landlord_payout','landlord_receivable_obligation'] LOOP
    IF public._cfo_paid_category_for(v_category) IS DISTINCT FROM 'landlord' THEN
      RAISE EXCEPTION 'Landlord reporting classification assertion failed for %', v_category;
    END IF;
  END LOOP;
  IF public._cfo_paid_category_for('payroll_expense') IS DISTINCT FROM 'budget'
     OR public._cfo_paid_category_for('agent_commission') IS DISTINCT FROM 'agent'
     OR public._cfo_paid_category_for('roi_expense') IS DISTINCT FROM 'partner'
     OR public._cfo_paid_category_for('marketing_expense') IS DISTINCT FROM 'marketing'
     OR public._cfo_paid_category_for('research_development_expense') IS DISTINCT FROM 'rnd'
     OR public._cfo_paid_category_for('wallet_transfer') IS NOT NULL THEN
    RAISE EXCEPTION 'Unrelated Money Out classification changed';
  END IF;
END
$migration$;