DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sandbox_exec') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.smoke_promissory_self_support() TO sandbox_exec';
  END IF;
END $$;