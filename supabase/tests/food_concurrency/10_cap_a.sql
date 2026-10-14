-- Scenario 1, Session A — per-employee order cap.
--
-- Places 1 item against a cap of 2, then HOLDS the transaction open for 8s.
-- The advisory lock food_place_order takes is transaction-scoped, so it is held
-- for that whole window. Start 11_cap_b.sql within ~2s of this.
--
-- Run first. DISPOSABLE DATABASE ONLY.
\set ON_ERROR_STOP on

\echo '=== Session A: starting, will hold its transaction ~8s ==='

BEGIN;

DO $a$
DECLARE
  EMP uuid := 'f0000000-0000-4000-8000-00000000000a';
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_item uuid;
  v_res jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', EMP)::text, true);

  SELECT mi.id INTO v_item
    FROM public.food_menu_items mi
    JOIN public.food_meals m ON m.id = mi.meal_id
    JOIN public.food_service_periods p ON p.id = mi.period_id
   WHERE m.name = 'CONCURRENCY-TEST Meal One'
     AND p.name = 'CONCURRENCY-TEST Window'
     AND mi.service_date = v_today;
  IF v_item IS NULL THEN
    RAISE EXCEPTION 'Fixtures missing — run 00_setup.sql first';
  END IF;

  INSERT INTO public.food_cc_test_log(scenario, session, note)
  VALUES ('cap','A','entering food_place_order');

  -- takes the advisory lock on (employee, period) and holds it until COMMIT
  v_res := public.food_place_order(
    jsonb_build_array(jsonb_build_object('menu_item_id', v_item, 'quantity', 1)),
    'cc-cap-a-' || gen_random_uuid()::text,
    'CONCURRENCY-TEST');

  INSERT INTO public.food_cc_test_log(scenario, session, note)
  VALUES ('cap','A','placed ' || (v_res->>'order_reference') || ' qty 1, holding lock');
END $a$;

-- Hold. Session B should be blocked for most of this.
SELECT pg_sleep(8);

-- Proof that the lock really is held by this backend while B waits.
\echo '--- advisory locks held by Session A while it waits ---'
SELECT locktype, classid, objid, granted
  FROM pg_locks
 WHERE locktype = 'advisory' AND pid = pg_backend_pid();

INSERT INTO public.food_cc_test_log(scenario, session, note)
VALUES ('cap','A','committing now');

COMMIT;

\echo '=== Session A: committed ==='
