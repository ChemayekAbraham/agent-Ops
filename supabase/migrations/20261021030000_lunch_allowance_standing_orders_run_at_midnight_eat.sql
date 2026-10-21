-- Daily lunch allowance standing orders must all run at 00:00 EAT (21:00 UTC) every day.
--
-- Before: process-scheduled-payouts was only swept at 00:00 UTC and 04:00 UTC, and a new
-- standing order took its first next_run_at from the time of day it was created, a day
-- later. Orders created at 07:11 UTC were never due at either sweep on the day they were
-- meant to start, and then paid at 03:00 EAT, one cycle behind.
--
-- After:
--   1. A BEFORE INSERT trigger snaps every new daily lunch_allowance order to the next 21:00 UTC.
--   2. Existing daily lunch_allowance orders are moved to the next 21:00 UTC.
--   3. run_lunch_allowance_payouts() calls process-scheduled-payouts once per due lunch order
--      (scoped by payout_id, so no other standing order is touched, for example airtime).
--   4. pg_cron runs it at 21:00 UTC. The existing 00:00 UTC and 04:00 UTC sweeps stay as a
--      fallback: if the 21:00 UTC call fails the order is still due and pays at 03:00 EAT.
-- computeNextRun in the edge function adds one day to next_run_at, so each order stays at 21:00 UTC.
--
-- Run each statement on its own. No DO block.

CREATE OR REPLACE FUNCTION public.snap_lunch_allowance_next_run()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.category_id = 'lunch_allowance' AND NEW.frequency = 'daily' THEN
    NEW.next_run_at := (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '21 hours') AT TIME ZONE 'UTC';
    IF NEW.next_run_at <= now() THEN
      NEW.next_run_at := NEW.next_run_at + interval '1 day';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_snap_lunch_allowance_next_run
  BEFORE INSERT ON public.scheduled_payouts
  FOR EACH ROW EXECUTE FUNCTION public.snap_lunch_allowance_next_run();

UPDATE public.scheduled_payouts
   SET next_run_at = CASE
         WHEN (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '21 hours') AT TIME ZONE 'UTC' > now()
           THEN (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '21 hours') AT TIME ZONE 'UTC'
         ELSE (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '45 hours') AT TIME ZONE 'UTC'
       END
 WHERE enabled
   AND category_id = 'lunch_allowance'
   AND frequency = 'daily';

CREATE OR REPLACE FUNCTION public.run_lunch_allowance_payouts()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT id
      FROM public.scheduled_payouts
     WHERE enabled
       AND category_id = 'lunch_allowance'
       AND frequency = 'daily'
       AND next_run_at <= now()
     ORDER BY next_run_at
  LOOP
    PERFORM net.http_post(
      url := 'https://byrzshwlentqvktcksem.supabase.co/functions/v1/process-scheduled-payouts',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ5cnpzaHdsZW50cXZrdGNrc2VtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4OTI3MTQsImV4cCI6MjEwNzQ2ODcxNH0.8oMYC39wCMHtVlevN1D8rQnIZgtcwJVpG6z3QnTXnAs"}'::jsonb,
      body := jsonb_build_object('payout_id', r.id)
    );
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$function$;

SELECT cron.schedule('lunch-allowance-0000-eat', '0 21 * * *', 'SELECT public.run_lunch_allowance_payouts();');
