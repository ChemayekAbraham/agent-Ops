-- Rolls back 20261113090000_log_system_stamped_weekly_repayment_frequency.sql
-- Restores the production definition exactly as it was before (SECURITY INVOKER, no audit row). Idempotent.
-- audit_logs rows already written stay (the table is append-only by design).

CREATE OR REPLACE FUNCTION public.stamp_rent_request_repayment_frequency()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF public.rent_request_is_weekly_shape(NEW.duration_days, NEW.registration_type)
     AND lower(COALESCE(NEW.repayment_frequency, 'daily')) = 'daily' THEN
    NEW.repayment_frequency := 'weekly';
  END IF;
  IF lower(COALESCE(NEW.repayment_frequency, 'daily')) = 'weekly'
     AND NEW.repayment_starts_on IS NULL THEN
    NEW.repayment_starts_on := (COALESCE(NEW.funded_at, NEW.created_at, now()) AT TIME ZONE 'Africa/Kampala')::date;
  END IF;
  RETURN NEW;
END;
$function$;
