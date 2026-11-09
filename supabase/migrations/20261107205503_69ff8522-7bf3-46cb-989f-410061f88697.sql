CREATE OR REPLACE FUNCTION public.desk_scripts_reader_ok()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
 SELECT (select auth.uid()) IS NOT NULL
 AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role::text = 'employee' AND coalesce(ur.enabled,true))
 AND EXISTS (SELECT 1 FROM public.desk_assignments d WHERE d.user_id = (select auth.uid()));
$$;
DO $$
DECLARE v_uid uuid;
BEGIN
 PERFORM set_config('request.jwt.claim.sub', '', true);
 IF public.desk_scripts_reader_ok() THEN RAISE EXCEPTION 'Anonymous access unexpectedly allowed'; END IF;
 SELECT d.user_id INTO v_uid FROM public.desk_assignments d JOIN public.user_roles ur ON ur.user_id=d.user_id WHERE ur.role::text='employee' AND coalesce(ur.enabled,true) LIMIT 1;
 IF v_uid IS NULL THEN RAISE EXCEPTION 'No desk staff for access test'; END IF;
 PERFORM set_config('request.jwt.claim.sub',v_uid::text,true);
 IF NOT public.desk_scripts_reader_ok() THEN RAISE EXCEPTION 'Desk staff access denied'; END IF;
 SELECT ur.user_id INTO v_uid FROM public.user_roles ur WHERE ur.enabled AND ur.role::text='supporter' AND NOT EXISTS(SELECT 1 FROM public.user_roles e WHERE e.user_id=ur.user_id AND e.role::text='employee' AND coalesce(e.enabled,true)) LIMIT 1;
 IF v_uid IS NULL THEN RAISE EXCEPTION 'No supporter for denial test'; END IF;
 PERFORM set_config('request.jwt.claim.sub',v_uid::text,true);
 IF public.desk_scripts_reader_ok() THEN RAISE EXCEPTION 'Nonstaff supporter access allowed'; END IF;
 PERFORM set_config('request.jwt.claim.sub','',true);
END $$;