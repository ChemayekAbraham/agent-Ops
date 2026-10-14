-- Scenario 2, Session A — stock reservation.
--
-- 'CONCURRENCY-TEST Meal Three' is scheduled with exactly ONE serving. A takes
-- it and holds. Here the serializing mechanism is the row lock the menu item
-- gets (FOR NO KEY UPDATE), backed by the food_menu_items_within_stock CHECK —
-- not the advisory cap lock. Both sessions want the same menu row, so they must
-- queue regardless of the cap.
--
-- Run first, then 21_stock_b.sql within ~2s. DISPOSABLE DATABASE ONLY.
\set ON_ERROR_STOP on

\echo '=== Stock Session A: taking the only serving, holding ~8s ==='

BEGIN;

DO $a$
DECLARE
  EMP uuid := 'f0000000-0000-4000-8000-00000000000a';
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_item uuid; v_res jsonb;
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

  INSERT INTO public.food_cc_test_log(scenario, session, note)
  VALUES ('stock','A','taking the last serving');

  v_res := public.food_place_order(
    jsonb_build_array(jsonb_build_object('menu_item_id', v_item, 'quantity', 1)),
    'cc-stock-a-' || gen_random_uuid()::text, 'CONCURRENCY-TEST');

  INSERT INTO public.food_cc_test_log(scenario, session, note)
  VALUES ('stock','A','reserved it via ' || (v_res->>'order_reference') || ', holding the row lock');
END $a$;

SELECT pg_sleep(8);

INSERT INTO public.food_cc_test_log(scenario, session, note)
VALUES ('stock','A','committing now');

COMMIT;

\echo '=== Stock Session A: committed ==='
