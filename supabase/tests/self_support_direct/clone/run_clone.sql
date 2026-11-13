SET client_min_messages = warning;
SET check_function_bodies = off;
SET search_path = public, extensions;
-- Applies every statement in a sub-transaction; failures are retried on the next pass
-- (a later object may have been what it needed), until a pass makes no progress.
DO $$
DECLARE r record; v_pass int := 0; v_progress int;
BEGIN
  LOOP
    v_pass := v_pass + 1; v_progress := 0;
    FOR r IN SELECT seq, sql FROM public._clone_stmts WHERE NOT done ORDER BY phase, seq LOOP
      BEGIN
        EXECUTE r.sql;
        UPDATE public._clone_stmts SET done = true, err = NULL WHERE seq = r.seq;
        v_progress := v_progress + 1;
      EXCEPTION WHEN OTHERS THEN
        UPDATE public._clone_stmts SET err = SQLERRM WHERE seq = r.seq;
      END;
    END LOOP;
    RAISE WARNING 'pass %: % applied', v_pass, v_progress;
    EXIT WHEN v_progress = 0 OR v_pass >= 6;
  END LOOP;
END $$;
SELECT phase, count(*) FILTER (WHERE done) AS ok, count(*) FILTER (WHERE NOT done) AS failed FROM public._clone_stmts GROUP BY phase ORDER BY phase;
