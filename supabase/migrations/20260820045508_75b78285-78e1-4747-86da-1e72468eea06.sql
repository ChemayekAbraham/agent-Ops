DO $mig$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_merchant_float_positions';

  v_new := replace(
    v_def,
    'OR session_user = ''service_role''' || E'\n' ||
    '    OR COALESCE(current_setting(''request.jwt.claim.role'', true), '''') = ''service_role'';',
    'OR public.is_service_role_request();'
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'previous service_role gate not found; aborting';
  END IF;

  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION public.is_service_role_request()
    RETURNS boolean
    LANGUAGE plpgsql
    STABLE
    SET search_path = public
    AS $body$
    DECLARE
      v_claims text;
    BEGIN
      IF session_user = 'service_role' OR current_user = 'service_role' THEN
        RETURN true;
      END IF;
      IF COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role' THEN
        RETURN true;
      END IF;
      v_claims := current_setting('request.jwt.claims', true);
      IF v_claims IS NOT NULL AND v_claims <> '' THEN
        BEGIN
          IF COALESCE((v_claims::json ->> 'role'), '') = 'service_role' THEN
            RETURN true;
          END IF;
        EXCEPTION WHEN others THEN
          NULL;
        END;
      END IF;
      RETURN false;
    END;
    $body$;
  $fn$;

  REVOKE ALL ON FUNCTION public.is_service_role_request() FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.is_service_role_request() TO authenticated, service_role;

  EXECUTE v_new;
END
$mig$;