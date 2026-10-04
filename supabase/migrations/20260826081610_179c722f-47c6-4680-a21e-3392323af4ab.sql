DO $body$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef('public.smoke_promissory_support_modes()'::regprocedure)
  INTO v_definition;

  v_definition := replace(v_definition, 'v_event_count integer;', 'v_event_count integer;\n  v_exception_detail text;');
  v_definition := replace(v_definition, 'EXCEPTION WHEN OTHERS THEN\n    IF SQLERRM = ''SMOKE_ROLLBACK'' THEN RETURN jsonb_build_object(''rolled_back'', true, ''results'', PG_EXCEPTION_DETAIL::jsonb); END IF;', 'EXCEPTION WHEN OTHERS THEN\n    GET STACKED DIAGNOSTICS v_exception_detail = PG_EXCEPTION_DETAIL;\n    IF SQLERRM = ''SMOKE_ROLLBACK'' THEN RETURN jsonb_build_object(''rolled_back'', true, ''results'', v_exception_detail::jsonb); END IF;');

  EXECUTE v_definition;
END
$body$;

REVOKE ALL ON FUNCTION public.smoke_promissory_support_modes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.smoke_promissory_support_modes() TO service_role;
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sandbox_exec') THEN
    GRANT EXECUTE ON FUNCTION public.smoke_promissory_support_modes() TO sandbox_exec;
  END IF;
END
$grant$;