DO $$
DECLARE f text; d text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.get_cfo_paid_by_category_totals(date,date)','public.get_cfo_paid_by_category_page(date,date,text,text,integer,integer)'] LOOP
    d := pg_get_functiondef(f::regprocedure);
    d := replace(d, 'public._cfo_paid_lunch_correction_ok(g.transaction_group_id)',
                    'public._cfo_paid_lunch_correction_ok(g.id, g.transaction_group_id, g.amount, g.transaction_date)');
    EXECUTE d;
  END LOOP;
END $$;