CREATE OR REPLACE FUNCTION public.enforce_agent_perf_withdrawal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- 20% daily-collection withdrawal gate REMOVED (2026-08-01).
  -- Kept attached as a permanent no-op for backward compatibility.
  RETURN NEW;
END;
$function$;