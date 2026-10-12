-- Scenario 2, Session B — the second claim on the last serving.
--
-- A DIFFERENT employee, so the advisory cap lock cannot be what saves us: the
-- protection has to come from the menu row lock plus the within-stock CHECK.
-- B must block on A's row lock and then be refused.
--
-- Start within ~2s of 20_stock_a.sql. DISPOSABLE DATABASE ONLY.
\set ON_ERROR_STOP on

\echo '=== Stock Session B: attempting the same last serving ==='

BEGIN;

DO $b$
DECLARE
  EMP uuid := 'f0000000-0000-4000-8000-00000000000b';   -- a DIFFERENT employee
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_item uuid; v_started timestamptz; v_waited numeric; v_res jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', EMP)::text, true);

  SELECT mi.id INTO v_item
    FROM public.food_menu_items mi
    JOIN public.food_meals m ON m.id = mi.meal_id
    JOIN public.food_service_periods p ON p.id = mi.period_id
   WHERE m.name = 'CONCURRENCY-TEST Meal Three'
     AND p.name = 'CONCURRENCY-TEST Window'
     AND mi.service_date = v_today;
  IF v_item IS NULL THEN RAISE EXCEPTION 'Fixtures missing — run 00_setup.sql first'; END IF;

  PERFORM pg_sleep(2);
  v_started := clock_timestamp();

  BEGIN
    v_res := public.food_place_order(
      jsonb_build_array(jsonb_build_object('menu_item_id', v_item, 'quantity', 1)),
      'cc-stock-b-' || gen_random_uuid()::text, 'CONCURRENCY-TEST');
    v_waited := EXTRACT(epoch FROM clock_timestamp() - v_started);
    INSERT INTO public.food_cc_test_log(scenario, session, note, waited_seconds)
    VALUES ('stock','B','FAIL: accepted ' || (v_res->>'order_reference')
                     || ' — the single serving was sold twice', v_waited);
  EXCEPTION WHEN OTHERS THEN
    v_waited := EXTRACT(epoch FROM clock_timestamp() - v_started);
    INSERT INTO public.food_cc_test_log(scenario, session, note, waited_seconds)
    VALUES ('stock','B','rejected: ' || left(SQLERRM, 80), v_waited);
  END;
END $b$;

COMMIT;

\echo '--- Stock result ---'
SELECT session, note, round(waited_seconds,2) AS waited_seconds
  FROM public.food_cc_test_log WHERE scenario = 'stock' ORDER BY at;

\echo ''
\echo 'INTERPRETATION:'
\echo '  waited ~5-6s AND rejected -> PASS, B queued behind A and stock held'
\echo '  accepted                  -> FAIL, the serving was oversold'
