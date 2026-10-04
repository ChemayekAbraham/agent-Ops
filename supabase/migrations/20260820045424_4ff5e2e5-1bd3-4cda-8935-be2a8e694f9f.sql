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
    'OR current_user = ''service_role'';',
    'OR session_user = ''service_role''' || E'\n' ||
    '    OR COALESCE(current_setting(''request.jwt.claim.role'', true), '''') = ''service_role'';'
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'service_role gate not found; aborting';
  END IF;

  EXECUTE v_new;
END
$mig$;