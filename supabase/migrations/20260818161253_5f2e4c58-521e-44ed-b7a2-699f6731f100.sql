BEGIN;
SET LOCAL lock_timeout = '5s';
GRANT EXECUTE ON FUNCTION public.invoke_hr_careers_acknowledge() TO postgres;
COMMIT;