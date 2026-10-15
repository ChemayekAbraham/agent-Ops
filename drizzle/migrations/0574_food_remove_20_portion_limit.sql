DO $$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('public.food_place_order(jsonb,text,text,text)'::regprocedure);
  d := replace(d, 'WHERE q > 20) THEN', 'WHERE q < 1) THEN');
  d := replace(d, 'You can order at most 20 servings of one meal', 'Quantity must be at least 1');
  IF d NOT LIKE '%WHERE q < 1) THEN%' THEN RAISE EXCEPTION 'patch failed place_order'; END IF;
  EXECUTE d;
  d := pg_get_functiondef('public.food_menu_for_day(date)'::regprocedure);
  d := replace(d, '''max_qty_per_line'', 20,', '''max_qty_per_line'', 100000,');
  IF d NOT LIKE '%100000%' THEN RAISE EXCEPTION 'patch failed menu'; END IF;
  EXECUTE d;
END $$;