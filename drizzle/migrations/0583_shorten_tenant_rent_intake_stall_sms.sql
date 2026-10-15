CREATE OR REPLACE FUNCTION public.queue_tenant_rent_intake_stall_notices()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  v_stage text;
  v_count integer := 0;
BEGIN
  FOR r IN
    SELECT id, status, updated_at, service_centre_name,
           floor(extract(epoch FROM (now() - updated_at)) / 172800)::int AS periods
      FROM public.tenant_rent_intake_requests
     WHERE status IN ('submitted','claimed','visit_verified','approved')
       AND updated_at < now() - interval '2 days'
  LOOP
    v_stage := 'reminder_' || r.status || '_' || r.periods::text;
    PERFORM public.queue_tenant_rent_intake_notice(
      r.id, v_stage,
      'Rent request still in progress',
      'Your rent request is still being worked on ('
        || CASE r.status
             WHEN 'submitted' THEN 'with ' || COALESCE(r.service_centre_name, 'the Service Centre')
             WHEN 'claimed' THEN 'agent review'
             WHEN 'visit_verified' THEN 'final review'
             ELSE 'rent plan being raised' END
        || '). We will update you as soon as it moves.',
      'Welile: Rent request in progress ('
        || CASE r.status
             WHEN 'submitted' THEN 'with ' || left(COALESCE(r.service_centre_name, 'the Service Centre'), 30)
             WHEN 'claimed' THEN 'agent review'
             WHEN 'visit_verified' THEN 'final review'
             ELSE 'Rent Plan being raised' END
        || '). We will update you when it moves.');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$function$;