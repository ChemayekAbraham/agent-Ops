-- Rollback for 20261024110000_partner_paid_outstanding.sql: removes the two read-only report functions it created.
-- They hold no data and nothing else depends on them in the database; the Partner page's Paid & Outstanding section
-- then shows its "unavailable" state. Refuses, changing nothing, unless both functions exist. Run as one transaction.
SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF to_regprocedure('public.get_partner_paid_outstanding(date,date)') IS NULL
     OR to_regprocedure('public.get_partner_paid_outstanding_items(text,text,date,date,integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: the functions 20261024110000_partner_paid_outstanding created are not both present; nothing was changed';
  END IF;
END
$pre$;

DROP FUNCTION public.get_partner_paid_outstanding_items(text, text, date, date, integer, integer);
DROP FUNCTION public.get_partner_paid_outstanding(date, date);

RESET lock_timeout;
