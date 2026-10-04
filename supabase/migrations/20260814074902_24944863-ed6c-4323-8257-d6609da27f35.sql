CREATE OR REPLACE FUNCTION public.get_service_centre_manager_network(
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 15,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  agent_id uuid,
  agent_name text,
  agent_phone text,
  centre_status text,
  centre_location text,
  centre_created_at timestamptz,
  sub_agents_managed bigint,
  sub_agents_pending bigint,
  houses_total bigint,
  houses_verified bigint,
  houses_pending bigint,
  landlords_total bigint,
  landlords_verified bigint,
  landlords_pending bigint,
  monthly_rent_verified numeric,
  lc1_verified bigint,
  lc1_pending bigint,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'super_admin') OR
    public.has_role(auth.uid(), 'manager') OR
    public.has_role(auth.uid(), 'ceo') OR
    public.has_role(auth.uid(), 'coo') OR
    public.has_role(auth.uid(), 'cfo') OR
    public.has_role(auth.uid(), 'operations') OR
    public.has_role(auth.uid(), 'landlord_ops') OR
    public.has_role(auth.uid(), 'agent_ops') OR
    public.has_role(auth.uid(), 'tenant_ops')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  WITH centres AS (
    SELECT DISTINCT ON (s.agent_id)
      s.agent_id,
      s.agent_name,
      s.agent_phone,
      s.status::text AS centre_status,
      s.location_name,
      s.created_at
    FROM public.service_centre_setups s
    WHERE COALESCE(s.status, 'pending') <> 'rejected'
    ORDER BY s.agent_id, s.created_at DESC
  ),
  filtered AS (
    SELECT c.*
    FROM centres c
    LEFT JOIN public.profiles p ON p.id = c.agent_id
    WHERE p_search IS NULL OR btrim(p_search) = ''
       OR c.agent_name ILIKE '%' || p_search || '%'
       OR COALESCE(c.agent_phone, '') ILIKE '%' || p_search || '%'
       OR COALESCE(p.full_name, '') ILIKE '%' || p_search || '%'
       OR COALESCE(c.location_name, '') ILIKE '%' || p_search || '%'
  ),
  counted AS (SELECT count(*) AS n FROM filtered),
  page AS (
    SELECT f.* FROM filtered f
    ORDER BY f.created_at DESC
    LIMIT GREATEST(p_limit, 1) OFFSET GREATEST(p_offset, 0)
  ),
  net AS (
    SELECT pg.agent_id,
           ARRAY(
             SELECT sa.sub_agent_id FROM public.agent_subagents sa
             WHERE sa.parent_agent_id = pg.agent_id AND sa.status = 'verified'
           ) || pg.agent_id AS ids
    FROM page pg
  )
  SELECT
    pg.agent_id,
    COALESCE(NULLIF(btrim(pr.full_name), ''), pg.agent_name)::text,
    COALESCE(NULLIF(btrim(pg.agent_phone), ''), pr.phone)::text,
    pg.centre_status,
    pg.location_name::text,
    pg.created_at,
    (SELECT count(*) FROM public.agent_subagents sa WHERE sa.parent_agent_id = pg.agent_id AND sa.status = 'verified'),
    (SELECT count(*) FROM public.agent_subagents sa WHERE sa.parent_agent_id = pg.agent_id AND sa.status <> 'verified'),
    (SELECT count(*) FROM public.house_listings h WHERE h.agent_id = ANY(n.ids)),
    (SELECT count(*) FROM public.house_listings h WHERE h.agent_id = ANY(n.ids) AND h.verified IS TRUE),
    (SELECT count(*) FROM public.house_listings h WHERE h.agent_id = ANY(n.ids) AND COALESCE(h.verified, false) IS FALSE),
    (SELECT count(*) FROM public.landlords l WHERE l.registered_by = ANY(n.ids)),
    (SELECT count(*) FROM public.landlords l WHERE l.registered_by = ANY(n.ids) AND l.verified IS TRUE),
    (SELECT count(*) FROM public.landlords l WHERE l.registered_by = ANY(n.ids) AND COALESCE(l.verified, false) IS FALSE),
    COALESCE((SELECT sum(h.monthly_rent) FROM public.house_listings h WHERE h.agent_id = ANY(n.ids) AND h.verified IS TRUE), 0),
    (SELECT count(*) FROM public.lc1_chairpersons c WHERE c.registered_by = ANY(n.ids) AND c.verified IS TRUE),
    (SELECT count(*) FROM public.lc1_chairpersons c WHERE c.registered_by = ANY(n.ids) AND COALESCE(c.verified, false) IS FALSE),
    (SELECT n FROM counted)
  FROM page pg
  JOIN net n ON n.agent_id = pg.agent_id
  LEFT JOIN public.profiles pr ON pr.id = pg.agent_id
  ORDER BY pg.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_service_centre_manager_network(text, integer, integer) TO authenticated;