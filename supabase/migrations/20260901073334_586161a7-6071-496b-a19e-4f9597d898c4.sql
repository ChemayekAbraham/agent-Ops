DROP FUNCTION IF EXISTS public.crm_platform_people_counts();

CREATE OR REPLACE FUNCTION public.crm_platform_people_counts()
 RETURNS TABLE(all_users bigint, tenants bigint, agents bigint, sub_agents bigint, partners bigint, landlords bigint, employees bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.crm_call_centre_authorized(auth.uid()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  RETURN QUERY
  SELECT (SELECT COUNT(*) FROM public.profiles),
         COUNT(*) FILTER (WHERE r.role = 'tenant'),
         COUNT(*) FILTER (WHERE r.role = 'agent'),
         COUNT(*) FILTER (WHERE r.role = 'sub_agent'),
         COUNT(*) FILTER (WHERE r.role = 'partner'),
         COUNT(*) FILTER (WHERE r.role = 'landlord'),
         COUNT(*) FILTER (WHERE r.role = 'employee')
    FROM public.v_crm_person_roles r;
END;
$function$;