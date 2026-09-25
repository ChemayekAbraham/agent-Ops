-- Allow borrower-facing lending repayment alerts through the notification
-- write-suppression trigger. All other notification types remain blocked.
CREATE OR REPLACE FUNCTION public.block_all_notification_inserts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(NEW.type, '') IN (
    'merchandise_recovery',
    'director_requisition',
    'advance_arrears',
    'budget',
    'staff_requisition',
    'hr_birthday',
    'rd_alert',
    'lending_repayment'
  ) THEN
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
