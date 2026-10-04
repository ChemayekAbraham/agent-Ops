DROP VIEW IF EXISTS public.v_partner_reserved_plan_ids;

CREATE OR REPLACE FUNCTION public.psm_reserved_plan_ids(p_rent_request_ids uuid[])
RETURNS TABLE(rent_request_id uuid, reserved_stage text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT x AS rent_request_id, public.psm_plan_partner_reserved_stage(x) AS reserved_stage
    FROM unnest(COALESCE(p_rent_request_ids, ARRAY[]::uuid[])) AS x
   WHERE public.psm_plan_partner_reserved_stage(x) IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.psm_reserved_plan_ids(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.psm_reserved_plan_ids(uuid[]) TO authenticated, service_role;