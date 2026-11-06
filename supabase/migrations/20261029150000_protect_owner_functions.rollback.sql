-- Removes the function protection. Run it with the same rights as the migration.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'protected-functions-check';
DROP EVENT TRIGGER IF EXISTS zz_protected_functions_guard;
DROP EVENT TRIGGER IF EXISTS zz_protected_functions_drop_guard;
DROP FUNCTION IF EXISTS public.protected_functions_guard();
DROP FUNCTION IF EXISTS public.protected_functions_drop_guard();
DROP FUNCTION IF EXISTS public.protected_functions_check();
DROP FUNCTION IF EXISTS public.protect_set_unlock_token(text, text);
DROP FUNCTION IF EXISTS public.protect_function(text);
DROP FUNCTION IF EXISTS public.unprotect_function(text);
DROP FUNCTION IF EXISTS public._pf_restore(text);
DROP FUNCTION IF EXISTS public._pf_log(text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public._pf_unlocked();
DROP FUNCTION IF EXISTS public._pf_identity(oid);
DROP TABLE IF EXISTS public.protected_function_changes;
DROP TABLE IF EXISTS public.protected_functions;
DROP TABLE IF EXISTS public.protected_function_settings;
