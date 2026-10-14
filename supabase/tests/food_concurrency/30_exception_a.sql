-- Scenario 3, Session A — exception resolution.
--
-- food_resolve_exception takes SELECT ... FOR UPDATE on the exception row and
-- rechecks resolved_at AFTER the lock. A resolves and holds; B must queue and
-- then find it already resolved. There is no uniqueness constraint behind this
-- — the lock-then-recheck is the only protection — which is exactly why it is
-- worth testing for real.
--
-- Run first, then 31_exception_b.sql within ~2s. DISPOSABLE DATABASE ONLY.
\set ON_ERROR_STOP on

\echo '=== Exception Session A: resolving, holding ~8s ==='

BEGIN;

DO $a$
DECLARE
  v_coord uuid; v_exc uuid; v_res jsonb;
BEGIN
  SELECT coordinator_id INTO v_coord FROM public.food_coordinator_assignments
   WHERE revoked_at IS NULL AND access_level = 'active' LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_coord)::text, true);

  -- a dedicated exception for this run, tagged so cleanup can find it
  INSERT INTO public.food_exceptions (order_id, kind, detail)
  VALUES (NULL, 'stock_shortfall',
          jsonb_build_object('note','CONCURRENCY-TEST','tag','CONCURRENCY-TEST'))
  RETURNING id INTO v_exc;

  INSERT INTO public.food_cc_test_log(scenario, session, note)
  VALUES ('exception','A','created and will resolve ' || v_exc::text);

  v_res := public.food_resolve_exception(v_exc, 'CONCURRENCY-TEST first resolver wins');

  INSERT INTO public.food_cc_test_log(scenario, session, note)
  VALUES ('exception','A','resolved, holding the row lock');
END $a$;

SELECT pg_sleep(8);

INSERT INTO public.food_cc_test_log(scenario, session, note)
VALUES ('exception','A','committing now');

COMMIT;

\echo '=== Exception Session A: committed ==='
