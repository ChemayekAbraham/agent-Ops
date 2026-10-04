
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
  COALESCE(NULLIF(p.country,''), NULLIF(lr.rr_country,''), 'Uganda') AS country,
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
