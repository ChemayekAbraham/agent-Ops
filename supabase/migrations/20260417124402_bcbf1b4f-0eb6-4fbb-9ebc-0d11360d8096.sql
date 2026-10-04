CREATE OR REPLACE FUNCTION public.prevent_cashout_self_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.assigned_by IS NULL THEN
    RAISE EXCEPTION 'Cashout agent assignment must record the authorising user (assigned_by is required).';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = NEW.assigned_by
      AND role IN ('cfo'::app_role, 'super_admin'::app_role, 'coo'::app_role)
  ) THEN
    RAISE EXCEPTION 'Only CFO, COO or Super Admin can assign cashout agents.';
  END IF;
  RETURN NEW;
END;
$function$;