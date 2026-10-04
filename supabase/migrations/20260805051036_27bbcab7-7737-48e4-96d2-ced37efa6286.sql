CREATE OR REPLACE FUNCTION public.psm_e2e_run()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  res jsonb;
  v_err text;
BEGIN
  BEGIN
    PERFORM set_config('psm.e2e', 'on', true);
    res := public.psm_e2e_smoke();
    -- force rollback of every dummy row created above
    RAISE EXCEPTION 'PSM_E2E_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err <> 'PSM_E2E_ROLLBACK' THEN
      res := jsonb_build_object('harness_error', v_err, 'partial', res);
    END IF;
  END;
  RETURN COALESCE(res, jsonb_build_object('harness_error', 'no result'));
END;
$function$;

REVOKE ALL ON FUNCTION public.psm_e2e_run() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.psm_e2e_run() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.psm_e2e_run() TO service_role;
GRANT EXECUTE ON FUNCTION public.psm_e2e_smoke() TO service_role;