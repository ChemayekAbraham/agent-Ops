DO $mig$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_merchant_float_positions';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'get_merchant_float_positions not found';
  END IF;

  IF position('OR current_user = ''service_role''' IN v_def) > 0 THEN
    RETURN; -- already patched
  END IF;

  v_new := replace(
    v_def,
    'OR public.has_role(auth.uid(), ''coo'');',
    'OR public.has_role(auth.uid(), ''coo'')' || E'\n' ||
    '    -- Trusted server-side callers (scheduled Merchant Float Morning Report)' || E'\n' ||
    '    -- have no auth.uid(); they must read the SAME figures as the board.' || E'\n' ||
    '    OR current_user = ''service_role'';'
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'authorization gate pattern not found; aborting';
  END IF;

  EXECUTE v_new;
END
$mig$;