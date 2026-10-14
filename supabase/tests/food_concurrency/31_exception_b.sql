-- Scenario 3, Session B — the second resolver.
--
-- Targets the same exception A is resolving. Must block on A's row lock, then
-- find resolved_at already set and refuse. A's reason and resolver must survive
-- untouched, and there must be exactly ONE audit entry.
--
-- Start within ~2s of 30_exception_a.sql. DISPOSABLE DATABASE ONLY.
\set ON_ERROR_STOP on

\echo '=== Exception Session B: attempting to resolve the same exception ==='

BEGIN;

DO $b$
DECLARE
  v_coord uuid; v_exc uuid; v_started timestamptz; v_waited numeric;
BEGIN
  SELECT coordinator_id INTO v_coord FROM public.food_coordinator_assignments
   WHERE revoked_at IS NULL AND access_level = 'active' LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_coord)::text, true);

  PERFORM pg_sleep(2);

  -- the exception A created for this run (uncommitted rows are invisible, so
  -- this picks the newest tagged one; if A has not committed it will be the
  -- one from this run only when A created it in a prior committed step)
  SELECT id INTO v_exc FROM public.food_exceptions
   WHERE detail->>'tag' = 'CONCURRENCY-TEST'
   ORDER BY created_at DESC LIMIT 1;

  IF v_exc IS NULL THEN
    -- A's INSERT is still uncommitted, which is the normal case. Fall back to
    -- the id A logged, so B targets exactly the row A is holding.
    SELECT substring(note from '([0-9a-f-]{36})')::uuid INTO v_exc
      FROM public.food_cc_test_log
     WHERE scenario='exception' AND session='A' AND note LIKE 'created and will resolve%'
     ORDER BY at DESC LIMIT 1;
  END IF;

  IF v_exc IS NULL THEN
    INSERT INTO public.food_cc_test_log(scenario, session, note)
    VALUES ('exception','B','SKIPPED: could not find the exception — run 30_exception_a.sql first');
    RETURN;
  END IF;

  v_started := clock_timestamp();
  BEGIN
    PERFORM public.food_resolve_exception(v_exc, 'CONCURRENCY-TEST second resolver must lose');
    v_waited := EXTRACT(epoch FROM clock_timestamp() - v_started);
    INSERT INTO public.food_cc_test_log(scenario, session, note, waited_seconds)
    VALUES ('exception','B','FAIL: resolved it a second time', v_waited);
  EXCEPTION WHEN OTHERS THEN
    v_waited := EXTRACT(epoch FROM clock_timestamp() - v_started);
    INSERT INTO public.food_cc_test_log(scenario, session, note, waited_seconds)
    VALUES ('exception','B','rejected: ' || left(SQLERRM, 80), v_waited);
  END;
END $b$;

COMMIT;

\echo '--- Exception result ---'
SELECT session, note, round(waited_seconds,2) AS waited_seconds
  FROM public.food_cc_test_log WHERE scenario='exception' ORDER BY at;

\echo ''
\echo 'INTERPRETATION:'
\echo '  waited ~5-6s AND rejected "already resolved" -> PASS'
\echo '  resolved twice                               -> FAIL, lock-then-recheck is not holding'
