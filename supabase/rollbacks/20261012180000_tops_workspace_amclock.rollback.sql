-- Rollback for 20261012180000_tops_workspace_amclock.sql
-- Drops every object that migration created: all functions in public whose name ends in _amclock,
-- plus the three internal helpers. Read-only objects only; no data is touched and no original
-- tops_* function, table, view, trigger or policy is involved.
DO $rb$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND (p.proname LIKE '%\_amclock' OR p.proname LIKE '%\_amclock\_for' OR p.proname IN ('_am_plan_clock_core', '_tops_am_schedule'))
       AND p.proname NOT IN ('am_plan_clock', 'am_plan_arrears', 'am_plan_positions')
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig::text || ' CASCADE';
  END LOOP;
END
$rb$;
