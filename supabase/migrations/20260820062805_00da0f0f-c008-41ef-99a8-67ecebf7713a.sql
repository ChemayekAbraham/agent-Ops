CREATE OR REPLACE FUNCTION public.search_all_agents(p_term text DEFAULT '', p_limit integer DEFAULT 30)
RETURNS TABLE(id uuid, full_name text, phone text, email text, agent_code text, role text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_term text := lower(trim(coalesce(p_term, '')));
  v_lim integer := least(greatest(coalesce(p_limit, 30), 1), 100);
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'agent_ops') OR public.has_role(auth.uid(), 'operations')
    OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'financial_ops')
    OR public.has_role(auth.uid(), 'admin')
  ) THEN
    RAISE EXCEPTION 'Not authorised to search agents';
  END IF;

  RETURN QUERY
  SELECT p.id,
         coalesce(p.full_name, 'Unknown') AS full_name,
         p.phone,
         p.email,
         upper(substr(replace(p.id::text, '-', ''), 1, 6)) AS agent_code,
         ur.role::text
  FROM public.profiles p
  JOIN (
    SELECT DISTINCT ON (user_id) user_id, role
    FROM public.user_roles
    WHERE role IN ('agent','senior_agent','sub_agent')
    ORDER BY user_id, role
  ) ur ON ur.user_id = p.id
  WHERE v_term = ''
     OR lower(coalesce(p.full_name, '')) LIKE '%' || v_term || '%'
     OR lower(coalesce(p.phone, '')) LIKE '%' || v_term || '%'
     OR lower(coalesce(p.email, '')) LIKE '%' || v_term || '%'
     OR lower(replace(p.id::text, '-', '')) LIKE lower(replace(v_term, '-', '')) || '%'
  ORDER BY p.full_name NULLS LAST
  LIMIT v_lim;
END;
$$;

REVOKE ALL ON FUNCTION public.search_all_agents(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_all_agents(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_all_agents(text, integer) TO service_role;