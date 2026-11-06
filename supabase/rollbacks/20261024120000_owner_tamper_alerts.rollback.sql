-- Goes back to "refuse with an error, no alert" for the owner-only settings. Re-run the guard function from 20261024110000_owner_only_settings.sql and
-- the restriction-function patch in it (replace the alerting branch with RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501').
DROP FUNCTION IF EXISTS public.list_owner_security_alerts(integer);
-- Keep owner_security_alerts and log_owner_tamper until the guard is restored, because the current guard calls log_owner_tamper.
-- DROP FUNCTION public.log_owner_tamper(text, text, jsonb, boolean);
-- DROP TABLE public.owner_security_alerts;
