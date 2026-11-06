-- Opens the controls back up to the CTO and super admins as before.
DROP TRIGGER IF EXISTS trg_00_owner_only_settings ON public.treasury_controls;
DROP FUNCTION IF EXISTS public.guard_owner_only_settings();
DO $rb$
DECLARE f text; v_oid oid; v_def text; v_new text;
BEGIN
  FOREACH f IN ARRAY ARRAY['list_financial_ops_restrictions', 'set_financial_ops_restriction', 'list_financial_ops_features'] LOOP
    SELECT p.oid INTO v_oid FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = f LIMIT 1;
    IF v_oid IS NULL THEN CONTINUE; END IF;
    v_def := pg_get_functiondef(v_oid);
    v_new := replace(v_def, 'IF NOT public.is_platform_owner() THEN',
      $q$IF NOT (public.has_role(auth.uid(), 'cto'::app_role) OR public.has_role(auth.uid(), 'super_admin'::app_role)) THEN$q$);
    IF v_new <> v_def THEN EXECUTE v_new; END IF;
  END LOOP;
END
$rb$;
-- platform_owner and is_platform_owner() are kept (harmless); drop them only if nothing else uses them.
