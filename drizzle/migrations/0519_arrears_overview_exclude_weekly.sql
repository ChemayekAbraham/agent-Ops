CREATE OR REPLACE FUNCTION public.agent_arrears_overview(p_agent_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid := COALESCE(p_agent_id, auth.uid()); v_out jsonb;
BEGIN
  IF v_agent IS NULL THEN RAISE EXCEPTION 'bad_request'; END IF;
  IF NOT (public.rent_arrears_read_authorized() OR auth.uid() = v_agent) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT jsonb_build_object(
           'agent_id', v_agent,
           'go_live', public.rent_arrears_go_live(),
           'as_at', (now() AT TIME ZONE 'Africa/Kampala')::timestamp(0),
           'totals', jsonb_build_object(
             'tenants_behind', COUNT(*) FILTER (WHERE a.arrears_ugx > 0),
             'arrears_ugx',    COALESCE(SUM(a.arrears_ugx), 0),
             'due_today_ugx',  COALESCE(SUM(a.due_today_ugx), 0),
             'days_behind',    COALESCE(SUM(a.days_behind), 0)),
           'tenants', COALESCE(jsonb_agg(jsonb_build_object(
             'rent_request_id', a.rent_request_id,
             'tenant_id', a.tenant_id,
             'tenant_name', p.full_name,
             'tenant_phone', p.phone,
             'days_behind', a.days_behind,
             'arrears_ugx', a.arrears_ugx,
             'due_today_ugx', a.due_today_ugx,
             'oldest_open_day', a.oldest_open_day)
             ORDER BY a.arrears_ugx DESC, a.days_behind DESC)
             FILTER (WHERE a.arrears_ugx > 0 OR a.due_today_ugx > 0), '[]'::jsonb)
         ) INTO v_out
  FROM public.v_rent_plan_arrears a
  JOIN public.rent_requests rr ON rr.id = a.rent_request_id
  LEFT JOIN public.profiles p ON p.id = a.tenant_id
  WHERE a.agent_id = v_agent
    AND COALESCE(lower(rr.repayment_frequency), 'daily') <> 'weekly';

  RETURN COALESCE(v_out, jsonb_build_object('agent_id', v_agent, 'tenants', '[]'::jsonb));
END;
$function$;