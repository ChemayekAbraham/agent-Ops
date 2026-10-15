CREATE OR REPLACE FUNCTION public.tenant_plan_due_now(p_rent_request_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT GREATEST(0, COALESCE((SELECT a.arrears FROM public._am_plan_arrears_core(ARRAY[p_rent_request_id], (now() AT TIME ZONE 'Africa/Kampala')::date) a LIMIT 1), 0));
$$;
REVOKE ALL ON FUNCTION public.tenant_plan_due_now(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_plan_due_now(uuid) TO service_role;