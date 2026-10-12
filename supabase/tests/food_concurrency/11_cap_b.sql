-- Scenario 1, Session B — the contender.
--
-- Same employee, same service period, a DIFFERENT meal — so A and B share no
-- menu row and therefore no row lock. The advisory cap lock is the only thing
-- that can serialize them. Without it both read the same count and the cap is
-- breached; with it B waits for A, then is rejected.
--
-- Start within ~2s of 10_cap_a.sql. DISPOSABLE DATABASE ONLY.
\set ON_ERROR_STOP on

\echo '=== Session B: starting, will attempt a second order ==='

BEGIN;

DO $b$
DECLARE
  EMP uuid := 'f0000000-0000-4000-8000-00000000000a';   -- the SAME employee as A
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_item uuid;
  v_started timestamptz;
  v_waited numeric;
  v_res jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', EMP)::text, true);

  SELECT mi.id INTO v_item
    FROM public.food_menu_items mi
    JOIN public.food_meals m ON m.id = mi.meal_id
    JOIN public.food_service_periods p ON p.id = mi.period_id
   WHERE m.name = 'CONCURRENCY-TEST Meal Two'          -- different meal to A
     AND p.name = 'CONCURRENCY-TEST Window'            -- same period as A
     AND mi.service_date = v_today;
  IF v_item IS NULL THEN
    RAISE EXCEPTION 'Fixtures missing — run 00_setup.sql first';
  END IF;

  -- give A a moment to get in and take the lock
  PERFORM pg_sleep(2);

  v_started := clock_timestamp();
  INSERT INTO public.food_cc_test_log(scenario, session, note)
  VALUES ('cap','B','calling food_place_order — expect to block here');

  BEGIN
    -- asks for 2; A already holds 1 of a cap of 2, so once serialized this
    -- must be refused
    v_res := public.food_place_order(
      jsonb_build_array(jsonb_build_object('menu_item_id', v_item, 'quantity', 2)),
      'cc-cap-b-' || gen_random_uuid()::text,
      'CONCURRENCY-TEST');

    v_waited := EXTRACT(epoch FROM clock_timestamp() - v_started);
    -- Reaching here means the cap was NOT enforced across sessions.
    INSERT INTO public.food_cc_test_log(scenario, session, note, waited_seconds)
    VALUES ('cap','B','FAIL: accepted ' || (v_res->>'order_reference')
                   || ' — the cap was breached across sessions', v_waited);
  EXCEPTION WHEN OTHERS THEN
    v_waited := EXTRACT(epoch FROM clock_timestamp() - v_started);
    INSERT INTO public.food_cc_test_log(scenario, session, note, waited_seconds)
    VALUES ('cap','B','rejected: ' || left(SQLERRM, 80), v_waited);
  END;
END $b$;

COMMIT;

\echo '--- Session B result (waited_seconds is the evidence) ---'
SELECT session, note, round(waited_seconds, 2) AS waited_seconds
  FROM public.food_cc_test_log
 WHERE scenario = 'cap'
 ORDER BY at;

\echo ''
\echo 'INTERPRETATION:'
\echo '  waited ~5-6s AND rejected  -> PASS, B blocked on A and the cap held'
\echo '  waited <1s  AND rejected   -> INCONCLUSIVE, A had already committed; retry with better overlap'
\echo '  accepted (any wait)        -> FAIL, the cap race is still open'
