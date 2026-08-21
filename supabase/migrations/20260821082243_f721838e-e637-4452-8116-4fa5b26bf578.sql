CREATE OR REPLACE FUNCTION public.get_my_parent_agent()
RETURNS TABLE (
  parent_agent_id uuid,
  full_name text,
  phone text,
  avatar_url text,
  location_label text,
  link_status text,
  linked_at timestamptz,
  invited_at timestamptz,
  service_centre_name text,
  service_centre_status text,
  service_centre_photo_url text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH link AS (
    SELECT s.parent_agent_id, s.status, s.accepted_at, s.created_at
    FROM public.agent_subagents s
    WHERE s.sub_agent_id = auth.uid()
    ORDER BY s.created_at ASC
    LIMIT 1
  )
  SELECT
    l.parent_agent_id,
    COALESCE(p.full_name, 'Your agent')::text,
    p.phone::text,
    p.avatar_url::text,
    NULLIF(
      concat_ws(', ',
        NULLIF(btrim(COALESCE(p.village, '')), ''),
        NULLIF(btrim(COALESCE(p.district, '')), ''),
        NULLIF(btrim(COALESCE(p.city, '')), ''),
        NULLIF(btrim(COALESCE(p.region, '')), '')
      ), ''
    )::text,
    l.status::text,
    l.accepted_at,
    l.created_at,
    sc.location_name::text,
    sc.status::text,
    sc.photo_url::text
  FROM link l
  LEFT JOIN public.profiles p ON p.id = l.parent_agent_id
  LEFT JOIN LATERAL (
    SELECT c.location_name, c.status, c.photo_url
    FROM public.service_centre_setups c
    WHERE c.agent_id = l.parent_agent_id
    ORDER BY (c.status = 'active') DESC, c.created_at DESC
    LIMIT 1
  ) sc ON true
$$;

REVOKE ALL ON FUNCTION public.get_my_parent_agent() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_parent_agent() TO authenticated;