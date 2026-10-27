-- Rollback of 20261027230000_special_advances_calc_engine. Needs explicit CFO approval. Drops the three pure
-- calculation functions; they hold no data. Refuses while any other function still depends on them by name (the later
-- Special Advances phases call them), so roll those back first.
-- TRANSACTION: run as ONE transaction (by hand: BEGIN; ... COMMIT;).
SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace
                AND p.proname NOT IN ('_special_advance_term_errors', '_special_advance_schedule', '_special_advance_allocate')
                AND p.prosrc ~ '_special_advance_(term_errors|schedule|allocate)\(') THEN
    RAISE EXCEPTION 'precondition failed: other functions still call the Special Advances engine; roll back the later phases first';
  END IF;
END
$pre$;
DROP FUNCTION IF EXISTS public._special_advance_allocate(jsonb, numeric);
DROP FUNCTION IF EXISTS public._special_advance_schedule(numeric, numeric, text, numeric, text, date);
DROP FUNCTION IF EXISTS public._special_advance_term_errors(numeric, numeric, text, numeric, text, date);
RESET lock_timeout;
