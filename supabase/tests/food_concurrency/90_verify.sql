-- Food concurrency tests — assertions.
--
-- Read-only. Raises on the first failure, so a clean run means every scenario
-- that was executed held. Scenarios you did not run are reported as SKIPPED
-- rather than silently passing.
\set ON_ERROR_STOP on

\echo '=== Verifying ==='

DO $verify$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_cap int; v_held int; v_orders int; v_waited numeric; v_note text;
  v_total int; v_reserved int; v_audit int; v_reason text;
BEGIN
  SELECT max_qty_per_employee INTO v_cap
    FROM public.food_service_periods WHERE name = 'CONCURRENCY-TEST Window';
  IF v_cap IS NULL THEN RAISE EXCEPTION 'Fixtures missing — run 00_setup.sql'; END IF;

  -- ── Scenario 1: the cap ────────────────────────────────────────────────
  SELECT note, waited_seconds INTO v_note, v_waited
    FROM public.food_cc_test_log
   WHERE scenario='cap' AND session='B' AND waited_seconds IS NOT NULL
   ORDER BY at DESC LIMIT 1;

  IF v_note IS NULL THEN
    RAISE NOTICE 'SKIPPED cap: session B never ran';
  ELSE
    IF v_note LIKE 'FAIL:%' THEN
      RAISE EXCEPTION 'CAP FAILED — B was accepted. The race is still open: %', v_note;
    END IF;

    -- the real assertion: the employee never holds more than the cap
    SELECT COALESCE(SUM(oi.quantity),0) INTO v_held
      FROM public.food_orders o
      JOIN public.food_order_items oi ON oi.order_id = o.id
      JOIN public.food_service_periods p ON p.id = o.period_id
     WHERE o.employee_id = 'f0000000-0000-4000-8000-00000000000a'
       AND p.name = 'CONCURRENCY-TEST Window'
       AND o.service_date = v_today
       AND o.fulfilment_status <> 'cancelled';
    IF v_held > v_cap THEN
      RAISE EXCEPTION 'CAP BREACHED: employee holds % against a cap of %', v_held, v_cap;
    END IF;

    -- no duplicate orders from the one attempt
    SELECT count(*) INTO v_orders FROM public.food_orders
     WHERE idempotency_key LIKE 'cc-cap-b-%';
    IF v_orders > 1 THEN
      RAISE EXCEPTION 'CAP: % orders from a single B attempt', v_orders;
    END IF;

    IF v_waited < 1 THEN
      RAISE WARNING 'CAP INCONCLUSIVE: B waited only %s — A had probably committed already. Re-run with tighter overlap.', round(v_waited,2);
    ELSE
      RAISE NOTICE 'CAP PASS: B blocked %s then was rejected; employee holds %/%',
        round(v_waited,2), v_held, v_cap;
    END IF;
  END IF;

  -- ── Scenario 2: stock ──────────────────────────────────────────────────
  SELECT note, waited_seconds INTO v_note, v_waited
    FROM public.food_cc_test_log
   WHERE scenario='stock' AND session='B' AND waited_seconds IS NOT NULL
   ORDER BY at DESC LIMIT 1;

  IF v_note IS NULL THEN
    RAISE NOTICE 'SKIPPED stock: session B never ran';
  ELSE
    IF v_note LIKE 'FAIL:%' THEN
      RAISE EXCEPTION 'STOCK FAILED — the single serving was sold twice: %', v_note;
    END IF;
    SELECT mi.servings_total, mi.servings_reserved INTO v_total, v_reserved
      FROM public.food_menu_items mi
      JOIN public.food_meals m ON m.id = mi.meal_id
      JOIN public.food_service_periods p ON p.id = mi.period_id
     WHERE m.name = 'CONCURRENCY-TEST Meal Three'
       AND p.name = 'CONCURRENCY-TEST Window' AND mi.service_date = v_today;
    IF v_reserved > v_total THEN
      RAISE EXCEPTION 'STOCK OVERSOLD: % reserved of %', v_reserved, v_total;
    END IF;
    RAISE NOTICE 'STOCK PASS: B waited %s and was rejected; % of % reserved',
      round(v_waited,2), v_reserved, v_total;
  END IF;

  -- ── Scenario 3: exception resolution ──────────────────────────────────
  SELECT note, waited_seconds INTO v_note, v_waited
    FROM public.food_cc_test_log
   WHERE scenario='exception' AND session='B' AND waited_seconds IS NOT NULL
   ORDER BY at DESC LIMIT 1;

  IF v_note IS NULL THEN
    RAISE NOTICE 'SKIPPED exception: session B never ran';
  ELSE
    IF v_note LIKE 'FAIL:%' THEN
      RAISE EXCEPTION 'EXCEPTION FAILED — resolved twice: %', v_note;
    END IF;

    SELECT e.resolution_reason INTO v_reason
      FROM public.food_exceptions e
     WHERE e.detail->>'tag' = 'CONCURRENCY-TEST'
     ORDER BY e.created_at DESC LIMIT 1;
    IF v_reason IS DISTINCT FROM 'CONCURRENCY-TEST first resolver wins' THEN
      RAISE EXCEPTION 'EXCEPTION: the first resolver''s reason did not survive — found %', COALESCE(v_reason,'NULL');
    END IF;

    SELECT count(*) INTO v_audit
      FROM public.food_audit a
     WHERE a.entity = 'exception'
       AND a.entity_id = (SELECT id FROM public.food_exceptions
                           WHERE detail->>'tag'='CONCURRENCY-TEST'
                           ORDER BY created_at DESC LIMIT 1);
    IF v_audit <> 1 THEN
      RAISE EXCEPTION 'EXCEPTION: expected exactly 1 audit entry, found %', v_audit;
    END IF;
    RAISE NOTICE 'EXCEPTION PASS: B waited %s and was rejected; 1 audit entry; first reason intact',
      round(v_waited,2);
  END IF;

  RAISE NOTICE 'Verification finished with no failures.';
END $verify$;

\echo '--- full session log ---'
SELECT scenario, session, note, round(waited_seconds,2) AS waited_seconds,
       to_char(at,'HH24:MI:SS.MS') AS at
FROM public.food_cc_test_log ORDER BY at;
