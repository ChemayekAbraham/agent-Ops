CREATE OR REPLACE FUNCTION public.agent_recalled_rent_request_ids(p_ids uuid[])
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT a.rent_request_id
    FROM public.landlord_float_idle_alerts a
    JOIN public.rent_requests rr ON rr.id = a.rent_request_id
   WHERE a.outcome = 'auto_recalled'
     AND a.rent_request_id = ANY(p_ids)
     AND rr.agent_id = auth.uid();
$$;
REVOKE ALL ON FUNCTION public.agent_recalled_rent_request_ids(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_recalled_rent_request_ids(uuid[]) TO authenticated;