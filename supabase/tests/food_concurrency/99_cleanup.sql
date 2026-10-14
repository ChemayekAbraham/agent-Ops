-- Food concurrency tests — teardown.
--
-- SCOPED, AND DELIBERATELY INCOMPLETE.
--
-- The food schema is append-only where it matters: food_orders, food_meals,
-- food_order_events and food_audit all carry no-delete triggers. This script
-- does NOT drop, disable or work around those triggers to tidy up — doing so
-- would weaken exactly the control the rest of this work exists to protect. So
-- orders and audit rows created by the run REMAIN, cancelled and clearly
-- labelled. That is why the suite is for a disposable database only.
--
-- Everything below is filtered to the run's own fixtures: names beginning
-- 'CONCURRENCY-TEST', the detail tag 'CONCURRENCY-TEST', idempotency keys
-- beginning 'cc-', or the reserved uuid range f0000000-0000-4000-8000-%.
-- Nothing else is read or written.
\set ON_ERROR_STOP on

\echo '=== Cleanup (scoped to CONCURRENCY-TEST fixtures) ==='

BEGIN;

DO $cleanup$
DECLARE
  v_coord uuid;
  v_cancelled int := 0;
  v_order record;
BEGIN
  SELECT coordinator_id INTO v_coord FROM public.food_coordinator_assignments
   WHERE revoked_at IS NULL AND access_level = 'active' LIMIT 1;

  -- 1. Cancel the test orders, which also releases their stock reservations.
  --    Done as the ordering employee, through the normal RPC, so the usual
  --    guards and the stock_released bookkeeping all apply.
  FOR v_order IN
    SELECT o.id, o.employee_id
      FROM public.food_orders o
     WHERE o.idempotency_key LIKE 'cc-%'
       AND o.fulfilment_status = 'confirmed'
       AND o.payment_status <> 'paid'
  LOOP
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_order.employee_id)::text, true);
    BEGIN
      PERFORM public.food_cancel_my_order(v_order.id, 'CONCURRENCY-TEST cleanup');
      v_cancelled := v_cancelled + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Could not cancel %: %', v_order.id, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE 'Cancelled % test order(s); their stock is back.', v_cancelled;

  -- 2. Take the test menu items off the menu and archive the test meals.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_coord)::text, true);

  UPDATE public.food_menu_items mi
     SET published_at = NULL, sold_out = true
   WHERE mi.meal_id IN (SELECT id FROM public.food_meals WHERE name LIKE 'CONCURRENCY-TEST%');

  PERFORM public.food_set_meal_status(m.id, 'archived', 'CONCURRENCY-TEST cleanup')
    FROM public.food_meals m
   WHERE m.name LIKE 'CONCURRENCY-TEST%' AND m.status <> 'archived';

  -- 3. Deactivate the test service periods (they are referenced by the orders
  --    that must survive, so they are not deleted).
  UPDATE public.food_service_periods
     SET active = false
   WHERE name LIKE 'CONCURRENCY-TEST%';

  -- 4. Release the coordinator seat only if this suite created it.
  UPDATE public.food_coordinator_assignments
     SET revoked_at = now(), reason = 'CONCURRENCY-TEST cleanup'
   WHERE coordinator_id = 'f0000000-0000-4000-8000-00000000000c'
     AND revoked_at IS NULL;
END $cleanup$;

-- 5. The run log is ours alone, so it can go entirely.
DROP TABLE IF EXISTS public.food_cc_test_log;

COMMIT;

\echo '--- what intentionally remains (append-only by design) ---'
SELECT 'cancelled test orders' AS item, count(*)::text AS n
  FROM public.food_orders WHERE idempotency_key LIKE 'cc-%'
UNION ALL
SELECT 'test audit rows', count(*)::text
  FROM public.food_audit WHERE reason LIKE 'CONCURRENCY-TEST%'
UNION ALL
SELECT 'test exceptions (resolved)', count(*)::text
  FROM public.food_exceptions WHERE detail->>'tag' = 'CONCURRENCY-TEST'
UNION ALL
SELECT 'archived test meals', count(*)::text
  FROM public.food_meals WHERE name LIKE 'CONCURRENCY-TEST%'
UNION ALL
SELECT 'stock left reserved on test items (should be 0)', COALESCE(SUM(servings_reserved),0)::text
  FROM public.food_menu_items mi
  JOIN public.food_meals m ON m.id = mi.meal_id
 WHERE m.name LIKE 'CONCURRENCY-TEST%';

\echo ''
\echo 'Test profiles f0000000-0000-4000-8000-00000000000a/b/c are left in place:'
\echo 'food tables hold foreign keys to profiles, so deleting them would fail.'
