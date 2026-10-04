CREATE OR REPLACE FUNCTION public.ops_search_transfer_agents(
  p_term text,
  p_exclude_agent_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 15
)
RETURNS TABLE (
  id uuid,
  full_name text,
  phone text,
  role text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_term text := btrim(coalesce(p_term, ''));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND coalesce(ur.enabled, true) = true
      AND ur.role IN (
        'manager','super_admin','ceo','coo','cto','cmo','crm','cfo','operations',
        'agent_ops','tenant_ops','landlord_ops','partner_ops','financial_ops'
      )
  ) THEN
    RAISE EXCEPTION 'Not authorised to search agents';
  END IF;

  IF length(v_term) < 3 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.id,
         p.full_name,
         p.phone,
         (SELECT ur.role::text
            FROM public.user_roles ur
           WHERE ur.user_id = p.id
             AND coalesce(ur.enabled, true) = true
             AND ur.role IN ('agent','senior_agent','sub_agent')
           ORDER BY CASE ur.role::text
                      WHEN 'senior_agent' THEN 1
                      WHEN 'agent' THEN 2
                      ELSE 3
                    END
           LIMIT 1) AS role
    FROM public.profiles p
   WHERE (p_exclude_agent_id IS NULL OR p.id <> p_exclude_agent_id)
     AND (p.full_name ILIKE '%' || v_term || '%' OR p.phone ILIKE '%' || v_term || '%')
     AND EXISTS (
       SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = p.id
          AND coalesce(ur.enabled, true) = true
          AND ur.role IN ('agent','senior_agent','sub_agent')
     )
   ORDER BY p.full_name NULLS LAST
   LIMIT greatest(1, least(coalesce(p_limit, 15), 50));
END;
$$;

REVOKE ALL ON FUNCTION public.ops_search_transfer_agents(text, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ops_search_transfer_agents(text, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_search_transfer_agents(text, uuid, integer) TO service_role;