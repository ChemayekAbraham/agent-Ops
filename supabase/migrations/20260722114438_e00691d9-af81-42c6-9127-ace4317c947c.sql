
CREATE OR REPLACE FUNCTION public.block_all_notification_inserts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Allowed notification types (small critical set)
  IF COALESCE(NEW.type, '') IN ('merchandise_recovery', 'director_requisition', 'advance_arrears') THEN
    RETURN NEW;
  END IF;
  -- Allowlist specific high-signal warnings by metadata.action
  IF COALESCE(NEW.metadata->>'action','') IN (
    'listing_rejected',
    'subagent_listing_rejected'
  ) THEN
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$function$;
