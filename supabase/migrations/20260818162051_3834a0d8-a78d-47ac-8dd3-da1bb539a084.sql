BEGIN;
SET LOCAL lock_timeout = '5s';
REVOKE EXECUTE ON FUNCTION public.invoke_hr_careers_acknowledge() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.invoke_hr_careers_acknowledge() FROM anon;
REVOKE EXECUTE ON FUNCTION public.invoke_hr_careers_acknowledge() FROM authenticated;
COMMIT;