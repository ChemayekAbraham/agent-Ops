
CREATE OR REPLACE VIEW public.v_tenant_location_pivot AS
WITH latest_rr AS (
  SELECT DISTINCT ON (rr.tenant_id)
    rr.tenant_id,
    rr.agent_id        AS rr_agent_id,
    rr.landlord_id     AS rr_landlord_id,
    rr.request_country AS rr_country,
    rr.request_city    AS rr_city,
    rr.tenant_photo_url,
    rr.house_image_urls,
    rr.house_category,
    rr.rent_amount,
    rr.id              AS rent_request_id,
    rr.created_at      AS rr_created_at
  FROM public.rent_requests rr
  WHERE rr.tenant_id IS NOT NULL
  ORDER BY rr.tenant_id, rr.created_at DESC
)
SELECT
  p.id                                                          AS tenant_id,
  COALESCE(p.full_name, 'Unnamed tenant')                       AS tenant_name,
  p.phone                                                       AS tenant_phone,
  p.avatar_url                                                  AS tenant_avatar_url,
  COALESCE(NULLIF(p.country,''), NULLIF(lr.rr_country,''), '— Unspecified country') AS country,
  COALESCE(NULLIF(p.region,''),  '— Unspecified region')        AS region,
  COALESCE(NULLIF(p.district,''),NULLIF(lr.rr_city,''), '— Unspecified district') AS district,
  COALESCE(NULLIF(p.sub_county,''),'— Unspecified ward')        AS ward,
  COALESCE(lr.rr_agent_id, p.managing_agent_id, p.referrer_id)  AS agent_id,
  lr.rr_landlord_id                                             AS landlord_id,
  lr.tenant_photo_url,
  lr.house_image_urls,
  lr.house_category,
  lr.rent_amount,
  lr.rent_request_id,
  p.created_at                                                  AS tenant_created_at
FROM public.profiles p
JOIN public.user_roles ur ON ur.user_id = p.id AND ur.role = 'tenant'
LEFT JOIN latest_rr lr ON lr.tenant_id = p.id;

GRANT SELECT ON public.v_tenant_location_pivot TO authenticated;

CREATE OR REPLACE FUNCTION public.get_tenant_location_breakdown(
  p_level     text,
  p_country   text DEFAULT NULL,
  p_region    text DEFAULT NULL,
  p_district  text DEFAULT NULL,
  p_ward      text DEFAULT NULL,
  p_agent_id  uuid DEFAULT NULL
) RETURNS TABLE (
  key          text,
  label        text,
  agent_id     uuid,
  landlord_id  uuid,
  agent_name   text,
  landlord_name text,
  total        integer,
  occupied     integer,
  vacant       integer,
  hidden       integer,
  revenue_ugx  bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF p_level = 'country' THEN
    RETURN QUERY
    SELECT t.country, t.country, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NULL)::int,
           0::int,
           COALESCE(SUM(t.rent_amount),0)::bigint
    FROM v_tenant_location_pivot t
    GROUP BY t.country ORDER BY COUNT(*) DESC;
  ELSIF p_level = 'region' THEN
    RETURN QUERY
    SELECT t.region, t.region, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NULL)::int,
           0::int,
           COALESCE(SUM(t.rent_amount),0)::bigint
    FROM v_tenant_location_pivot t
    WHERE t.country = p_country
    GROUP BY t.region ORDER BY COUNT(*) DESC;
  ELSIF p_level = 'district' THEN
    RETURN QUERY
    SELECT t.district, t.district, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NULL)::int,
           0::int,
           COALESCE(SUM(t.rent_amount),0)::bigint
    FROM v_tenant_location_pivot t
    WHERE t.country = p_country AND t.region = p_region
    GROUP BY t.district ORDER BY COUNT(*) DESC;
  ELSIF p_level = 'ward' THEN
    RETURN QUERY
    SELECT t.ward, t.ward, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NULL)::int,
           0::int,
           COALESCE(SUM(t.rent_amount),0)::bigint
    FROM v_tenant_location_pivot t
    WHERE t.country = p_country AND t.region = p_region AND t.district = p_district
    GROUP BY t.ward ORDER BY COUNT(*) DESC;
  ELSIF p_level = 'agent' THEN
    RETURN QUERY
    SELECT COALESCE(t.agent_id::text,'unassigned'),
           COALESCE(p.full_name, CASE WHEN t.agent_id IS NULL THEN '— No agent on file' ELSE 'Unnamed agent' END),
           t.agent_id, NULL::uuid, p.full_name, NULL::text,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NULL)::int,
           0::int,
           COALESCE(SUM(t.rent_amount),0)::bigint
    FROM v_tenant_location_pivot t
    LEFT JOIN profiles p ON p.id = t.agent_id
    WHERE t.country = p_country AND t.region = p_region
      AND t.district = p_district AND t.ward = p_ward
    GROUP BY t.agent_id, p.full_name ORDER BY COUNT(*) DESC;
  ELSIF p_level = 'landlord' THEN
    RETURN QUERY
    SELECT COALESCE(t.landlord_id::text,'unassigned'),
           COALESCE(p.full_name, CASE WHEN t.landlord_id IS NULL THEN '— No landlord on file' ELSE 'Unnamed landlord' END),
           t.agent_id, t.landlord_id, NULL::text, p.full_name,
           COUNT(*)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NOT NULL)::int,
           COUNT(*) FILTER (WHERE t.landlord_id IS NULL)::int,
           0::int,
           COALESCE(SUM(t.rent_amount),0)::bigint
    FROM v_tenant_location_pivot t
    LEFT JOIN profiles p ON p.id = t.landlord_id
    WHERE t.country = p_country AND t.region = p_region
      AND t.district = p_district AND t.ward = p_ward
      AND (t.agent_id = p_agent_id OR (p_agent_id IS NULL AND t.agent_id IS NULL))
    GROUP BY t.landlord_id, t.agent_id, p.full_name ORDER BY COUNT(*) DESC;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_location_breakdown(text,text,text,text,text,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_tenants_at_leaf(
  p_country     text,
  p_region      text,
  p_district    text,
  p_ward        text,
  p_agent_id    uuid,
  p_landlord_id uuid,
  p_limit       integer DEFAULT 300
) RETURNS TABLE (
  tenant_id         uuid,
  tenant_name       text,
  tenant_phone      text,
  tenant_avatar_url text,
  tenant_photo_url  text,
  house_image_urls  text[],
  house_category    text,
  rent_amount       numeric,
  rent_request_id   uuid,
  agent_id          uuid,
  agent_name        text,
  landlord_id       uuid,
  landlord_name     text,
  country           text,
  region            text,
  district          text,
  ward              text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    t.tenant_id, t.tenant_name, t.tenant_phone, t.tenant_avatar_url,
    t.tenant_photo_url, t.house_image_urls, t.house_category, t.rent_amount, t.rent_request_id,
    t.agent_id, pa.full_name, t.landlord_id, pl.full_name,
    t.country, t.region, t.district, t.ward
  FROM v_tenant_location_pivot t
  LEFT JOIN profiles pa ON pa.id = t.agent_id
  LEFT JOIN profiles pl ON pl.id = t.landlord_id
  WHERE t.country  = p_country
    AND t.region   = p_region
    AND t.district = p_district
    AND t.ward     = p_ward
    AND (t.agent_id    = p_agent_id    OR (p_agent_id    IS NULL AND t.agent_id    IS NULL))
    AND (t.landlord_id = p_landlord_id OR (p_landlord_id IS NULL AND t.landlord_id IS NULL))
  ORDER BY t.tenant_name NULLS LAST
  LIMIT GREATEST(p_limit, 1);
$$;

GRANT EXECUTE ON FUNCTION public.get_tenants_at_leaf(text,text,text,text,uuid,uuid,integer) TO authenticated;
