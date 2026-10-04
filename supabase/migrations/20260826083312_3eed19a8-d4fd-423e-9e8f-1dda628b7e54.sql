DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sandbox_exec') THEN
    GRANT EXECUTE ON FUNCTION public.get_promissory_ops_report(timestamp with time zone, timestamp with time zone) TO sandbox_exec;
  END IF;
END
$grant$;