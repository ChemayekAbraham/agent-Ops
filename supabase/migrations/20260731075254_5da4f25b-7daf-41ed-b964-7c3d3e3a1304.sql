CREATE OR REPLACE FUNCTION public.ops_search_house_listings(
  p_status text DEFAULT 'pending',
  p_search text DEFAULT NULL,
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL,
  p_sort text DEFAULT 'newest',
  p_limit int DEFAULT 30,
  p_offset int DEFAULT 0,
  p_quick text DEFAULT 'all'
)
RETURNS TABLE (listing jsonb, total_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
  v_like text;
  v_limit int := least(greatest(coalesce(p_limit, 30), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_quick text := lower(coalesce(p_quick, 'all'));
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  v_like := CASE WHEN v_q IS NULL THEN NULL ELSE '%' || v_q || '%' END;

  RETURN QUERY
  WITH matched AS (
    SELECT
      hl.*,
      ll.name  AS ll_name,
      ll.phone AS ll_phone,
      ap.full_name AS agent_name,
      ap.phone     AS agent_phone,
      ap.email     AS agent_email,
      tp.full_name AS tenant_name,
      tp.phone     AS tenant_phone,
      to_jsonb(ll) AS landlord_json
    FROM public.house_listings hl
    LEFT JOIN public.landlords ll ON ll.id = hl.landlord_id
    LEFT JOIN public.profiles  ap ON ap.id = hl.agent_id
    LEFT JOIN public.profiles  tp ON tp.id = hl.tenant_id
    WHERE
      CASE lower(coalesce(p_status, 'pending'))
        WHEN 'pending'  THEN coalesce(hl.verified, false) = false AND coalesce(hl.status,'') NOT IN ('rejected','delisted')
        WHEN 'verified' THEN coalesce(hl.verified, false) = true  AND coalesce(hl.status,'') NOT IN ('rejected','delisted')
        WHEN 'hidden'   THEN coalesce(hl.is_hidden, false) = true AND coalesce(hl.status,'') NOT IN ('rejected','delisted')
        WHEN 'rejected' THEN hl.status = 'rejected'
        ELSE coalesce(hl.status,'') NOT IN ('rejected','delisted')
      END
      AND CASE v_quick
        WHEN 'has_landlord' THEN hl.landlord_id IS NOT NULL
        WHEN 'no_landlord'  THEN hl.landlord_id IS NULL
        WHEN 'has_images'   THEN coalesce(array_length(hl.image_urls, 1), 0) > 0
        WHEN 'has_gps'      THEN hl.latitude IS NOT NULL AND hl.longitude IS NOT NULL
        WHEN 'has_lc1'      THEN nullif(btrim(coalesce(hl.lc1_chairperson_name,'')),'') IS NOT NULL
        ELSE true
      END
      AND (p_date_from IS NULL OR hl.created_at >= p_date_from)
      AND (p_date_to   IS NULL OR hl.created_at <= p_date_to)
      AND (
        v_like IS NULL
        OR hl.title ILIKE v_like
        OR hl.district ILIKE v_like
        OR hl.village ILIKE v_like
        OR hl.region ILIKE v_like
        OR hl.address ILIKE v_like
        OR hl.lc1_chairperson_name ILIKE v_like
        OR hl.lc1_chairperson_phone ILIKE v_like
        OR ll.name ILIKE v_like
        OR ll.phone ILIKE v_like
        OR ap.full_name ILIKE v_like
        OR ap.phone ILIKE v_like
        OR ap.email ILIKE v_like
        OR tp.full_name ILIKE v_like
        OR tp.phone ILIKE v_like
      )
  ), counted AS (
    SELECT count(*)::bigint AS n FROM matched
  )
  SELECT
    jsonb_build_object(
      'id', m.id,
      'title', m.title,
      'house_category', m.house_category,
      'monthly_rent', m.monthly_rent,
      'daily_rate', m.daily_rate,
      'number_of_rooms', m.number_of_rooms,
      'address', m.address,
      'district', m.district,
      'village', m.village,
      'region', m.region,
      'latitude', m.latitude,
      'longitude', m.longitude,
      'image_urls', m.image_urls,
      'lc1_chairperson_name', m.lc1_chairperson_name,
      'lc1_chairperson_phone', m.lc1_chairperson_phone,
      'lc1_chairperson_village', m.lc1_chairperson_village,
      'agent_id', m.agent_id,
      'landlord_id', m.landlord_id,
      'tenant_id', m.tenant_id,
      'verified', m.verified,
      'listing_bonus_paid', m.listing_bonus_paid,
      'created_at', m.created_at,
      'updated_at', m.updated_at,
      'status', m.status,
      'is_hidden', m.is_hidden,
      'agent_name', m.agent_name,
      'agent_phone', m.agent_phone,
      'agent_email', m.agent_email,
      'tenant_name', m.tenant_name,
      'tenant_phone', m.tenant_phone,
      'landlords', CASE WHEN m.landlord_id IS NULL THEN NULL ELSE m.landlord_json END
    ) AS listing,
    c.n AS total_count
  FROM matched m CROSS JOIN counted c
  ORDER BY
    CASE WHEN lower(coalesce(p_sort,'newest')) = 'oldest' THEN m.created_at END ASC,
    CASE WHEN lower(coalesce(p_sort,'newest')) = 'highest_rent' THEN coalesce(m.monthly_rent,0) END DESC,
    CASE WHEN lower(coalesce(p_sort,'newest')) = 'recently_updated' THEN coalesce(m.updated_at, m.created_at) END DESC,
    CASE WHEN lower(coalesce(p_sort,'newest')) NOT IN ('oldest','highest_rent','recently_updated') THEN m.created_at END DESC
  LIMIT v_limit OFFSET v_offset;
END;
$$;

REVOKE ALL ON FUNCTION public.ops_search_house_listings(text, text, timestamptz, timestamptz, text, int, int, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.ops_search_house_listings(text, text, timestamptz, timestamptz, text, int, int, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ops_house_quick_filter_counts(
  p_status text DEFAULT 'pending',
  p_search text DEFAULT NULL,
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL
)
RETURNS TABLE (all_scope bigint, has_landlord bigint, no_landlord bigint, has_images bigint, has_gps bigint, has_lc1 bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
  v_like text;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  v_like := CASE WHEN v_q IS NULL THEN NULL ELSE '%' || v_q || '%' END;

  RETURN QUERY
  WITH matched AS (
    SELECT hl.landlord_id, hl.image_urls, hl.latitude, hl.longitude, hl.lc1_chairperson_name
    FROM public.house_listings hl
    LEFT JOIN public.landlords ll ON ll.id = hl.landlord_id
    LEFT JOIN public.profiles  ap ON ap.id = hl.agent_id
    LEFT JOIN public.profiles  tp ON tp.id = hl.tenant_id
    WHERE
      CASE lower(coalesce(p_status, 'pending'))
        WHEN 'pending'  THEN coalesce(hl.verified, false) = false AND coalesce(hl.status,'') NOT IN ('rejected','delisted')
        WHEN 'verified' THEN coalesce(hl.verified, false) = true  AND coalesce(hl.status,'') NOT IN ('rejected','delisted')
        WHEN 'hidden'   THEN coalesce(hl.is_hidden, false) = true AND coalesce(hl.status,'') NOT IN ('rejected','delisted')
        WHEN 'rejected' THEN hl.status = 'rejected'
        ELSE coalesce(hl.status,'') NOT IN ('rejected','delisted')
      END
      AND (p_date_from IS NULL OR hl.created_at >= p_date_from)
      AND (p_date_to   IS NULL OR hl.created_at <= p_date_to)
      AND (
        v_like IS NULL
        OR hl.title ILIKE v_like
        OR hl.district ILIKE v_like
        OR hl.village ILIKE v_like
        OR hl.region ILIKE v_like
        OR hl.address ILIKE v_like
        OR hl.lc1_chairperson_name ILIKE v_like
        OR hl.lc1_chairperson_phone ILIKE v_like
        OR ll.name ILIKE v_like
        OR ll.phone ILIKE v_like
        OR ap.full_name ILIKE v_like
        OR ap.phone ILIKE v_like
        OR ap.email ILIKE v_like
        OR tp.full_name ILIKE v_like
        OR tp.phone ILIKE v_like
      )
  )
  SELECT
    count(*)::bigint,
    count(*) FILTER (WHERE landlord_id IS NOT NULL)::bigint,
    count(*) FILTER (WHERE landlord_id IS NULL)::bigint,
    count(*) FILTER (WHERE coalesce(array_length(image_urls, 1), 0) > 0)::bigint,
    count(*) FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL)::bigint,
    count(*) FILTER (WHERE nullif(btrim(coalesce(lc1_chairperson_name,'')),'') IS NOT NULL)::bigint
  FROM matched;
END;
$$;

REVOKE ALL ON FUNCTION public.ops_house_quick_filter_counts(text, text, timestamptz, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.ops_house_quick_filter_counts(text, text, timestamptz, timestamptz) TO authenticated, service_role;