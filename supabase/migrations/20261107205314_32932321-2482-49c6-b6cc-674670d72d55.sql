CREATE OR REPLACE FUNCTION public.desk_scripts_reader_ok()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
 SELECT (select auth.uid()) IS NOT NULL
 AND public._is_active_employee((select auth.uid()))
 AND EXISTS (SELECT 1 FROM public.desk_assignments d WHERE d.user_id = (select auth.uid()));
$$;
REVOKE ALL ON FUNCTION public.desk_scripts_reader_ok() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.desk_scripts_reader_ok() TO authenticated, service_role;
ALTER POLICY desk_scripts_read ON public.desk_scripts TO authenticated USING ((select public.desk_scripts_reader_ok()));
DO $$
DECLARE v_uid uuid; v_actual boolean;
BEGIN
 PERFORM set_config('request.jwt.claim.sub', '', true);
 IF public.desk_scripts_reader_ok() THEN RAISE EXCEPTION 'Anonymous script read unexpectedly allowed'; END IF;
 SELECT d.user_id INTO v_uid FROM public.desk_assignments d WHERE public._is_active_employee(d.user_id) LIMIT 1;
 IF v_uid IS NULL THEN RAISE EXCEPTION 'No active desk staff available to verify access'; END IF;
 PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
 IF NOT public.desk_scripts_reader_ok() THEN RAISE EXCEPTION 'Active desk staff script access denied'; END IF;
 SELECT ur.user_id INTO v_uid FROM public.user_roles ur WHERE ur.enabled AND ur.role::text = 'supporter' AND NOT public._is_active_employee(ur.user_id) LIMIT 1;
 IF v_uid IS NULL THEN RAISE EXCEPTION 'No nonstaff supporter available to verify denial'; END IF;
 PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
 IF public.desk_scripts_reader_ok() THEN RAISE EXCEPTION 'Nonstaff supporter script access unexpectedly allowed'; END IF;
 PERFORM set_config('request.jwt.claim.sub', '', true);
END $$;