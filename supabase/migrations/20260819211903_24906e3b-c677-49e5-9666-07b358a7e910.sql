CREATE OR REPLACE FUNCTION public.block_all_notification_inserts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(NEW.type, '') IN ('merchandise_recovery', 'director_requisition', 'advance_arrears', 'budget') THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.metadata->>'action','') IN (
    'listing_rejected',
    'subagent_listing_rejected'
  ) THEN
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$function$;

-- Re-run the announcement for currently open cycles; rows already recorded in
-- budget_cycle_notifications were suppressed before, so clear those and re-send once.
DELETE FROM public.budget_cycle_notifications n
 USING public.budget_calls c
 WHERE c.id = n.call_id AND c.status = 'open';

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.budget_calls WHERE status = 'open' LOOP
    PERFORM public.budget_notify_cycle_open(r.id);
  END LOOP;
END $$;