DO $$
DECLARE
  v_totals text;
  v_page text;
BEGIN
  -- ---- totals function ----
  v_totals := pg_get_functiondef('public.get_cfo_paid_by_category_totals(date,date)'::regprocedure);
  ASSERT position('(''landlord'', ''Landlord Products and Services'', 5),' in v_totals) > 0, 'totals: landlord row not found';
  ASSERT position('(''marketing'', ''Marketing Expenses'', 6),' in v_totals) > 0, 'totals: marketing row not found';
  ASSERT position('(''rnd'', ''Product Research & Development'', 7)' in v_totals) > 0, 'totals: rnd row not found';
  ASSERT position('Tenant Products and Services' in v_totals) = 0, 'totals: tenant row already present';
  v_totals := replace(v_totals,
    '(''landlord'', ''Landlord Products and Services'', 5),',
    '(''landlord'', ''Landlord Products and Services'', 5),
    (''tenant'', ''Tenant Products and Services'', 6),');
  v_totals := replace(v_totals, '(''marketing'', ''Marketing Expenses'', 6),', '(''marketing'', ''Marketing Expenses'', 7),');
  v_totals := replace(v_totals, '(''rnd'', ''Product Research & Development'', 7)', '(''rnd'', ''Product Research & Development'', 8)');
  EXECUTE v_totals;

  -- ---- page function ----
  v_page := pg_get_functiondef('public.get_cfo_paid_by_category_page(date,date,text,text,integer,integer)'::regprocedure);
  ASSERT position('WHEN ''landlord'' THEN ''Landlord Products and Services''' in v_page) > 0, 'page: landlord label not found';
  ASSERT position('WHEN ''marketing'' THEN ''Marketing Expenses''' in v_page) > 0, 'page: marketing label not found';
  ASSERT position('Tenant Products and Services' in v_page) = 0, 'page: tenant label already present';
  v_page := replace(v_page,
    'WHEN ''landlord'' THEN ''Landlord Products and Services'' WHEN ''marketing'' THEN ''Marketing Expenses''',
    'WHEN ''landlord'' THEN ''Landlord Products and Services'' WHEN ''tenant'' THEN ''Tenant Products and Services'' WHEN ''marketing'' THEN ''Marketing Expenses''');
  EXECUTE v_page;
END $$;