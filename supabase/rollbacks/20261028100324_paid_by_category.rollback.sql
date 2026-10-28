-- Rollback of 2026-10-28 CFO "Paid by Category" report (reporting only; no data was ever written).
-- Drops the three report functions created for the CFO dashboard Paid by Category screen.

SET lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regprocedure('public.get_cfo_paid_by_category_page(date,date,text,text,integer,integer)') IS NULL
     OR to_regprocedure('public.get_cfo_paid_by_category_totals(date,date)') IS NULL
     OR to_regprocedure('public._cfo_paid_category_for(text)') IS NULL THEN
    RAISE NOTICE 'paid-by-category functions not all present; dropping the ones that exist';
  END IF;
END
$pre$;

DROP FUNCTION IF EXISTS public.get_cfo_paid_by_category_page(date, date, text, text, integer, integer);
DROP FUNCTION IF EXISTS public.get_cfo_paid_by_category_totals(date, date);
DROP FUNCTION IF EXISTS public._cfo_paid_category_for(text);

RESET lock_timeout;
