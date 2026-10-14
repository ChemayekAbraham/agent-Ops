-- Food concurrency tests — fixtures.
--
-- DISPOSABLE DATABASE ONLY. Creates real rows and commits them; Session A has
-- to commit for Session B to see anything. Everything created here is tagged
-- CONCURRENCY-TEST or sits in the reserved uuid range f0000000-0000-4000-8000-%,
-- and 99_cleanup.sql is scoped to exactly that.
\set ON_ERROR_STOP on

BEGIN;

-- Refuse to run anywhere that looks like it holds real food data. A disposable
-- copy seeded by these tests will be far below this; a live canteen will not.
DO $guard$
DECLARE v_orders bigint;
BEGIN
  SELECT count(*) INTO v_orders FROM public.food_orders;
  IF v_orders > 500 THEN
    RAISE EXCEPTION
      'Refusing to run: % food orders present. This suite writes and commits; point it at a disposable database.',
      v_orders;
  END IF;
END $guard$;

-- ── people ────────────────────────────────────────────────────────────────
INSERT INTO public.profiles (id, full_name, email) VALUES
  ('f0000000-0000-4000-8000-00000000000a','CONCURRENCY-TEST EMPLOYEE A','cc-test-a@invalid.test'),
  ('f0000000-0000-4000-8000-00000000000b','CONCURRENCY-TEST EMPLOYEE B','cc-test-b@invalid.test'),
  ('f0000000-0000-4000-8000-00000000000c','CONCURRENCY-TEST COORDINATOR','cc-test-c@invalid.test')
ON CONFLICT (id) DO NOTHING;

-- An active Food Coordinator is needed to publish a menu. Reuse the real one if
-- there is one; only appoint the test account when the seat is empty, so this
-- never displaces a live assignment.
INSERT INTO public.food_coordinator_assignments (coordinator_id, access_level, assigned_by, reason)
SELECT 'f0000000-0000-4000-8000-00000000000c', 'active',
       'f0000000-0000-4000-8000-00000000000c', 'CONCURRENCY-TEST'
WHERE NOT EXISTS (
  SELECT 1 FROM public.food_coordinator_assignments
   WHERE revoked_at IS NULL AND access_level = 'active');

COMMIT;

-- ── menu, as the active coordinator ───────────────────────────────────────
BEGIN;
DO $setup$
DECLARE
  v_coord uuid;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_period uuid; v_other uuid; m1 uuid; m2 uuid; m3 uuid;
BEGIN
  SELECT coordinator_id INTO v_coord
    FROM public.food_coordinator_assignments
   WHERE revoked_at IS NULL AND access_level = 'active' LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_coord)::text, true);

  DELETE FROM public.food_service_closures WHERE closure_date = v_today;

  -- CAP OF 2. Scenario 1 depends on this number; 90_verify.sql reads it back
  -- rather than assuming, so changing it here does not silently break the test.
  v_period := public.food_upsert_service_period(
    NULL, 'CONCURRENCY-TEST Window', '00:00', '23:59', 'CONCURRENCY-TEST', 2, true, NULL);
  -- an unrelated period, to show it is not dragged into the same lock
  v_other  := public.food_upsert_service_period(
    NULL, 'CONCURRENCY-TEST Window Two', '00:00', '23:59', 'CONCURRENCY-TEST', 2, true, NULL);

  -- THREE DISTINCT MEALS. Scenario 1 needs A and B to share no menu row, so
  -- that the ONLY thing that can serialize them is the advisory cap lock.
  m1 := public.food_upsert_meal(NULL,'CONCURRENCY-TEST Meal One',  NULL,NULL,1000,NULL,'CONCURRENCY-TEST');
  m2 := public.food_upsert_meal(NULL,'CONCURRENCY-TEST Meal Two',  NULL,NULL,1000,NULL,'CONCURRENCY-TEST');
  m3 := public.food_upsert_meal(NULL,'CONCURRENCY-TEST Meal Three',NULL,NULL,1000,NULL,'CONCURRENCY-TEST');
  PERFORM public.food_set_meal_status(m1,'published','CONCURRENCY-TEST');
  PERFORM public.food_set_meal_status(m2,'published','CONCURRENCY-TEST');
  PERFORM public.food_set_meal_status(m3,'published','CONCURRENCY-TEST');

  -- plenty of stock for the cap scenario: the cap must be what bites, not stock
  PERFORM public.food_schedule_meal(v_today, v_period, m1, 1000, 100, true);
  PERFORM public.food_schedule_meal(v_today, v_period, m2, 1000, 100, true);
  -- exactly ONE serving for the stock scenario
  PERFORM public.food_schedule_meal(v_today, v_period, m3, 1000, 1,   true);
  -- the unrelated period
  PERFORM public.food_schedule_meal(v_today, v_other,  m1, 1000, 100, true);
END $setup$;
COMMIT;

-- ── a record of what the sessions did, so verification is not guesswork ──
CREATE TABLE IF NOT EXISTS public.food_cc_test_log(
  id bigserial PRIMARY KEY,
  scenario text NOT NULL,
  session  text NOT NULL,
  note     text NOT NULL,
  waited_seconds numeric,
  at timestamptz NOT NULL DEFAULT clock_timestamp());

\echo '--- setup complete ---'
SELECT p.name AS period, p.max_qty_per_employee AS cap,
       (SELECT string_agg(m.name || ' -> ' || mi.id::text, E'\n  ' ORDER BY m.name)
          FROM public.food_menu_items mi
          JOIN public.food_meals m ON m.id = mi.meal_id
         WHERE mi.period_id = p.id
           AND mi.service_date = (now() AT TIME ZONE 'Africa/Kampala')::date) AS menu_item_ids
FROM public.food_service_periods p
WHERE p.name LIKE 'CONCURRENCY-TEST%'
ORDER BY p.name;
