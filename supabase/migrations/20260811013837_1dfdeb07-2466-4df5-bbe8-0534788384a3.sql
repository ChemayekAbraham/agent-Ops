-- 1. Name normaliser (immutable, index-friendly)
CREATE OR REPLACE FUNCTION public.ug_norm_name(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT NULLIF(
    regexp_replace(
      regexp_replace(
        lower(coalesce(p, '')),
        '(district|city council|city|municipal council|municipality|town council|sub[- ]?county|subcounty|division|county)',
        '',
        'g'
      ),
      '[^a-z0-9]', '', 'g'
    ),
  '');
$$;

-- 2. Alias lookups from the ug_* dataset
DROP MATERIALIZED VIEW IF EXISTS public.mv_ug_district_alias CASCADE;
CREATE MATERIALIZED VIEW public.mv_ug_district_alias AS
SELECT DISTINCT ON (public.ug_norm_name(d.name))
  public.ug_norm_name(d.name) AS norm_key,
  d.id                        AS district_id,
  d.name                      AS district_name,
  d.region                    AS region
FROM public.ug_districts d
WHERE public.ug_norm_name(d.name) IS NOT NULL
ORDER BY public.ug_norm_name(d.name), d.id;
CREATE UNIQUE INDEX idx_mv_ug_district_alias_key ON public.mv_ug_district_alias (norm_key);
CREATE INDEX idx_mv_ug_district_alias_id ON public.mv_ug_district_alias (district_id);

DROP MATERIALIZED VIEW IF EXISTS public.mv_ug_subcounty_alias CASCADE;
CREATE MATERIALIZED VIEW public.mv_ug_subcounty_alias AS
SELECT DISTINCT ON (d.id, public.ug_norm_name(s.name))
  d.id                        AS district_id,
  public.ug_norm_name(s.name) AS norm_key,
  s.id                        AS subcounty_id,
  s.name                      AS subcounty_name,
  d.name                      AS district_name,
  d.region                    AS region
FROM public.ug_subcounties s
JOIN public.ug_counties c ON c.id = s.county_id
JOIN public.ug_districts d ON d.id = c.district_id
WHERE public.ug_norm_name(s.name) IS NOT NULL
ORDER BY d.id, public.ug_norm_name(s.name), s.id;
CREATE UNIQUE INDEX idx_mv_ug_subcounty_alias_key ON public.mv_ug_subcounty_alias (district_id, norm_key);

DROP MATERIALIZED VIEW IF EXISTS public.mv_ug_village_geo CASCADE;
CREATE MATERIALIZED VIEW public.mv_ug_village_geo AS
SELECT
  v.id   AS village_id,
  v.name AS village_name,
  pa.id  AS parish_id,
  pa.name AS parish_name,
  s.id   AS subcounty_id,
  s.name AS subcounty_name,
  d.id   AS district_id,
  d.name AS district_name,
  d.region AS region
FROM public.ug_villages v
JOIN public.ug_parishes pa ON pa.id = v.parish_id
JOIN public.ug_subcounties s ON s.id = pa.subcounty_id
JOIN public.ug_counties c ON c.id = s.county_id
JOIN public.ug_districts d ON d.id = c.district_id;
CREATE UNIQUE INDEX idx_mv_ug_village_geo_id ON public.mv_ug_village_geo (village_id);

GRANT SELECT ON public.mv_ug_district_alias TO anon, authenticated, service_role;
GRANT SELECT ON public.mv_ug_subcounty_alias TO anon, authenticated, service_role;
GRANT SELECT ON public.mv_ug_village_geo TO anon, authenticated, service_role;

-- refresher used by maintenance jobs
CREATE OR REPLACE FUNCTION public.refresh_ug_geo_alias()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_ug_district_alias;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_ug_subcounty_alias;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_ug_village_geo;
END;
$$;

-- 3. Tenant location pivot (resolved ids/names, single "Unmapped" bucket)
DROP VIEW IF EXISTS public.v_tenant_ops_tenant_base;
DROP VIEW IF EXISTS public.v_tenant_location_pivot;

CREATE VIEW public.v_tenant_location_pivot AS
WITH latest_rr AS (
  SELECT DISTINCT ON (rr.tenant_id) rr.tenant_id,
    rr.agent_id AS rr_agent_id,
    rr.landlord_id AS rr_landlord_id,
    rr.request_country AS rr_country,
    rr.request_city AS rr_city,
    rr.tenant_photo_url,
    rr.house_image_urls,
    rr.house_category,
    rr.rent_amount,
    rr.id AS rent_request_id,
    rr.created_at AS rr_created_at
  FROM rent_requests rr
  WHERE rr.tenant_id IS NOT NULL
  ORDER BY rr.tenant_id, rr.created_at DESC
)
SELECT
  p.id AS tenant_id,
  COALESCE(p.full_name, 'Unnamed tenant') AS tenant_name,
  p.phone AS tenant_phone,
  p.avatar_url AS tenant_avatar_url,
  COALESCE(NULLIF(p.country, ''), NULLIF(lr.rr_country, ''), 'Uganda') AS country,
  COALESCE(vg.region, da.region, dc.region, 'Unmapped') AS region,
  COALESCE(vg.district_name, da.district_name, dc.district_name, 'Unmapped') AS district,
  COALESCE(vg.subcounty_name, sa.subcounty_name, 'Unmapped') AS ward,
  COALESCE(vg.district_id, da.district_id, dc.district_id) AS district_id,
  COALESCE(vg.subcounty_id, sa.subcounty_id) AS subcounty_id,
  COALESCE(lr.rr_agent_id, p.managing_agent_id, p.referrer_id) AS agent_id,
  lr.rr_landlord_id AS landlord_id,
  lr.tenant_photo_url,
  lr.house_image_urls,
  lr.house_category,
  lr.rent_amount,
  lr.rent_request_id,
  p.created_at AS tenant_created_at
FROM profiles p
JOIN user_roles ur ON ur.user_id = p.id AND ur.role = 'tenant'::app_role
LEFT JOIN latest_rr lr ON lr.tenant_id = p.id
LEFT JOIN mv_ug_village_geo vg ON vg.village_id = p.ug_village_id
LEFT JOIN mv_ug_district_alias da
  ON vg.village_id IS NULL AND da.norm_key = public.ug_norm_name(NULLIF(p.district, ''))
LEFT JOIN mv_ug_district_alias dc
  ON vg.village_id IS NULL AND da.district_id IS NULL
 AND dc.norm_key = public.ug_norm_name(NULLIF(lr.rr_city, ''))
LEFT JOIN mv_ug_subcounty_alias sa
  ON vg.village_id IS NULL
 AND sa.district_id = COALESCE(da.district_id, dc.district_id)
 AND sa.norm_key = public.ug_norm_name(NULLIF(p.sub_county, ''));

GRANT SELECT ON public.v_tenant_location_pivot TO authenticated, service_role;

CREATE VIEW public.v_tenant_ops_tenant_base AS
WITH latest_rr AS (
  SELECT DISTINCT ON (rr.tenant_id) rr.tenant_id,
    rr.id AS rent_request_id,
    rr.agent_id,
    rr.landlord_id,
    rr.status,
    rr.registration_type,
    rr.rent_amount,
    rr.total_repayment,
    rr.amount_repaid,
    rr.daily_repayment,
    rr.duration_days,
    rr.funded_at,
    rr.created_at AS rr_created_at,
    rr.tenancy_status,
    rr.agent_payment_status,
    rr.house_listing_id
  FROM rent_requests rr
  WHERE rr.tenant_id IS NOT NULL
    AND rr.status <> ALL (ARRAY['rejected','deleted_by_agent'])
  ORDER BY rr.tenant_id, rr.created_at DESC
), pay AS (
  SELECT c.tenant_id,
    max(c.created_at) AS last_payment_at,
    sum(c.amount) AS lifetime_paid,
    sum(c.amount) FILTER (WHERE ((c.created_at AT TIME ZONE 'Africa/Kampala')::date = ((now() AT TIME ZONE 'Africa/Kampala')::date)) ) AS paid_today,
    sum(c.amount) FILTER (WHERE ((c.created_at AT TIME ZONE 'Africa/Kampala')::date >= (date_trunc('week', (((now() AT TIME ZONE 'Africa/Kampala')::date)::timestamptz)))::date)) AS paid_week,
    sum(c.amount) FILTER (WHERE ((c.created_at AT TIME ZONE 'Africa/Kampala')::date >= (date_trunc('month', (((now() AT TIME ZONE 'Africa/Kampala')::date)::timestamptz)))::date)) AS paid_month,
    sum(c.amount) FILTER (WHERE ((c.created_at AT TIME ZONE 'Africa/Kampala')::date >= (date_trunc('quarter', (((now() AT TIME ZONE 'Africa/Kampala')::date)::timestamptz)))::date)) AS paid_quarter,
    sum(c.amount) FILTER (WHERE ((c.created_at AT TIME ZONE 'Africa/Kampala')::date >= (date_trunc('year', (((now() AT TIME ZONE 'Africa/Kampala')::date)::timestamptz)))::date)) AS paid_year
  FROM agent_collections c
  WHERE c.tenant_id IS NOT NULL
  GROUP BY c.tenant_id
)
SELECT
  tenant_id, tenant_name, tenant_phone, tenant_avatar_url, tenant_created_at,
  continent, country, region, district, ward,
  agent_id, landlord_id, rent_request_id, rr_status, registration_type,
  tenancy_status, agent_payment_status, house_listing_id, duration_days,
  rent_amount, total_repayment, amount_repaid, daily_repayment, funded_at,
  funded_date, days_since_funded, expected_to_date, is_active,
  last_payment_at, lifetime_paid, paid_today, paid_week, paid_month, paid_quarter, paid_year,
  GREATEST(total_repayment - amount_repaid, 0::numeric) AS outstanding,
  GREATEST(expected_to_date - amount_repaid, 0::numeric) AS arrears_amount,
  GREATEST(amount_repaid - expected_to_date, 0::numeric) AS advance_amount,
  CASE WHEN daily_repayment > 0 THEN (floor(amount_repaid / daily_repayment))::int - days_since_funded ELSE NULL::int END AS schedule_delta_days,
  CASE WHEN daily_repayment > 0 AND funded_date IS NOT NULL AND (total_repayment - amount_repaid) > 0
    THEN funded_date + ((floor(amount_repaid / daily_repayment))::int + 1) ELSE NULL::date END AS next_due_date,
  CASE WHEN funded_date IS NOT NULL AND duration_days IS NOT NULL THEN funded_date + duration_days ELSE NULL::date END AS lease_end_date,
  district_id,
  subcounty_id
FROM (
  SELECT t.tenant_id, t.tenant_name, t.tenant_phone, t.tenant_avatar_url, t.tenant_created_at,
    continent_for_country(t.country) AS continent,
    t.country, t.region, t.district, t.ward, t.district_id, t.subcounty_id,
    COALESCE(lr.agent_id, t.agent_id) AS agent_id,
    COALESCE(lr.landlord_id, t.landlord_id) AS landlord_id,
    lr.rent_request_id, lr.status AS rr_status, lr.registration_type,
    lr.tenancy_status, lr.agent_payment_status, lr.house_listing_id, lr.duration_days,
    COALESCE(lr.rent_amount, 0::numeric) AS rent_amount,
    COALESCE(lr.total_repayment, 0::numeric) AS total_repayment,
    COALESCE(lr.amount_repaid, 0::numeric) AS amount_repaid,
    COALESCE(lr.daily_repayment, 0::numeric) AS daily_repayment,
    lr.funded_at,
    (lr.funded_at AT TIME ZONE 'Africa/Kampala')::date AS funded_date,
    GREATEST(COALESCE(((now() AT TIME ZONE 'Africa/Kampala')::date - (lr.funded_at AT TIME ZONE 'Africa/Kampala')::date), 0), 0) AS days_since_funded,
    CASE WHEN lr.funded_at IS NULL OR COALESCE(lr.daily_repayment, 0::numeric) <= 0 THEN 0::numeric
      ELSE LEAST(COALESCE(lr.total_repayment, 0::numeric), lr.daily_repayment * (GREATEST(((now() AT TIME ZONE 'Africa/Kampala')::date - (lr.funded_at AT TIME ZONE 'Africa/Kampala')::date), 0))::numeric) END AS expected_to_date,
    (lr.status = ANY (ARRAY['funded','repaying']) AND COALESCE(lr.agent_payment_status, 'paying') <> 'not_paying') AS is_active,
    p.last_payment_at,
    COALESCE(p.lifetime_paid, 0::numeric) AS lifetime_paid,
    COALESCE(p.paid_today, 0::numeric) AS paid_today,
    COALESCE(p.paid_week, 0::numeric) AS paid_week,
    COALESCE(p.paid_month, 0::numeric) AS paid_month,
    COALESCE(p.paid_quarter, 0::numeric) AS paid_quarter,
    COALESCE(p.paid_year, 0::numeric) AS paid_year
  FROM v_tenant_location_pivot t
  JOIN latest_rr lr ON lr.tenant_id = t.tenant_id
  LEFT JOIN pay p ON p.tenant_id = t.tenant_id
) b;

GRANT SELECT ON public.v_tenant_ops_tenant_base TO authenticated, service_role;

-- 4. Property base
DROP VIEW IF EXISTS public.v_tenant_ops_property_base;
CREATE VIEW public.v_tenant_ops_property_base AS
SELECT
  h.id AS listing_id,
  h.agent_id,
  h.landlord_id,
  h.tenant_id,
  h.status,
  h.is_hidden,
  h.verified,
  (COALESCE(h.monthly_rent, 0))::numeric AS monthly_rent,
  h.created_at,
  continent_for_country(COALESCE(NULLIF(l.country, ''), 'Uganda')) AS continent,
  COALESCE(NULLIF(l.country, ''), 'Uganda') AS country,
  COALESCE(vg.region, da.region, dl.region, 'Unmapped') AS region,
  COALESCE(vg.district_name, da.district_name, dl.district_name, 'Unmapped') AS district,
  (h.tenant_id IS NOT NULL OR h.status = 'occupied') AS is_occupied,
  COALESCE(vg.district_id, da.district_id, dl.district_id) AS district_id,
  COALESCE(vg.subcounty_id, sa.subcounty_id) AS subcounty_id,
  COALESCE(vg.subcounty_name, sa.subcounty_name, 'Unmapped') AS ward
FROM house_listings h
LEFT JOIN landlords l ON l.id = h.landlord_id
LEFT JOIN mv_ug_village_geo vg ON vg.village_id = h.ug_village_id
LEFT JOIN mv_ug_district_alias da
  ON vg.village_id IS NULL AND da.norm_key = public.ug_norm_name(NULLIF(h.district, ''))
LEFT JOIN mv_ug_district_alias dl
  ON vg.village_id IS NULL AND da.district_id IS NULL
 AND dl.norm_key = public.ug_norm_name(NULLIF(l.district, ''))
LEFT JOIN mv_ug_subcounty_alias sa
  ON vg.village_id IS NULL
 AND sa.district_id = COALESCE(da.district_id, dl.district_id)
 AND sa.norm_key = public.ug_norm_name(NULLIF(h.sub_county, ''))
WHERE h.status <> 'rejected';

GRANT SELECT ON public.v_tenant_ops_property_base TO authenticated, service_role;

-- 5. Landlord base
DROP VIEW IF EXISTS public.v_tenant_ops_landlord_base;
CREATE VIEW public.v_tenant_ops_landlord_base AS
SELECT
  l.id AS landlord_id,
  l.name AS landlord_name,
  l.phone,
  l.verified,
  l.created_at,
  l.managed_by_agent_id AS agent_id,
  COALESCE(l.monthly_rent, 0::numeric) AS monthly_rent,
  continent_for_country(COALESCE(NULLIF(l.country, ''), 'Uganda')) AS continent,
  COALESCE(NULLIF(l.country, ''), 'Uganda') AS country,
  COALESCE(vg.region, da.region, 'Unmapped') AS region,
  COALESCE(vg.district_name, da.district_name, 'Unmapped') AS district,
  COALESCE(vg.district_id, da.district_id) AS district_id,
  vg.subcounty_id AS subcounty_id
FROM landlords l
LEFT JOIN mv_ug_village_geo vg ON vg.village_id = l.ug_village_id
LEFT JOIN mv_ug_district_alias da
  ON vg.village_id IS NULL AND da.norm_key = public.ug_norm_name(NULLIF(l.district, ''));

GRANT SELECT ON public.v_tenant_ops_landlord_base TO authenticated, service_role;

-- 6. Agent ops directory
DROP VIEW IF EXISTS public.vw_agent_ops_directory;
CREATE VIEW public.vw_agent_ops_directory AS
SELECT
  p.id AS agent_id,
  p.full_name,
  p.phone,
  p.email,
  COALESCE(vg.region, da.region, 'Unmapped') AS region,
  COALESCE(vg.district_name, da.district_name, 'Unmapped') AS district,
  p.territory,
  p.agent_tier,
  p.is_frozen,
  p.frozen_reason,
  p.last_active_at,
  p.verified,
  COALESCE(c.active_count, 0::bigint) AS active_capability_count,
  COALESCE(c.total_count, 0::bigint) AS total_capability_count,
  COALESCE(vg.district_id, da.district_id) AS district_id,
  vg.subcounty_id AS subcounty_id
FROM profiles p
JOIN user_roles ur ON ur.user_id = p.id AND ur.role = 'agent'::app_role
LEFT JOIN (
  SELECT agent_capabilities.agent_id,
    count(*) FILTER (WHERE agent_capabilities.status = 'active') AS active_count,
    count(*) AS total_count
  FROM agent_capabilities
  GROUP BY agent_capabilities.agent_id
) c ON c.agent_id = p.id
LEFT JOIN mv_ug_village_geo vg ON vg.village_id = p.ug_village_id
LEFT JOIN mv_ug_district_alias da
  ON vg.village_id IS NULL AND da.norm_key = public.ug_norm_name(NULLIF(p.district, ''));

GRANT SELECT ON public.vw_agent_ops_directory TO authenticated, service_role;

-- 7. House location rollup (resolved, with ids)
DROP MATERIALIZED VIEW IF EXISTS public.mv_house_location_rollup CASCADE;
CREATE MATERIALIZED VIEW public.mv_house_location_rollup AS
SELECT
  'Uganda'::text AS country,
  COALESCE(vg.region, da.region, 'Unmapped') AS region,
  COALESCE(vg.district_name, da.district_name, 'Unmapped') AS district,
  COALESCE(vg.subcounty_name, sa.subcounty_name, 'Unmapped') AS ward,
  h.agent_id,
  h.landlord_id,
  COALESCE(vg.district_id, da.district_id) AS district_id,
  COALESCE(vg.subcounty_id, sa.subcounty_id) AS subcounty_id,
  (count(*))::integer AS total,
  (count(*) FILTER (WHERE h.tenant_id IS NOT NULL))::integer AS occupied,
  (count(*) FILTER (WHERE h.tenant_id IS NULL))::integer AS vacant,
  (count(*) FILTER (WHERE h.is_hidden = true))::integer AS hidden,
  COALESCE(sum(h.monthly_rent) FILTER (WHERE h.tenant_id IS NOT NULL), 0::bigint) AS revenue_ugx
FROM house_listings h
LEFT JOIN mv_ug_village_geo vg ON vg.village_id = h.ug_village_id
LEFT JOIN mv_ug_district_alias da
  ON vg.village_id IS NULL AND da.norm_key = public.ug_norm_name(NULLIF(h.district, ''))
LEFT JOIN mv_ug_subcounty_alias sa
  ON vg.village_id IS NULL AND sa.district_id = da.district_id
 AND sa.norm_key = public.ug_norm_name(NULLIF(h.sub_county, ''))
GROUP BY 1, 2, 3, 4, h.agent_id, h.landlord_id, 7, 8;

CREATE INDEX idx_mv_loc_rollup_country ON public.mv_house_location_rollup (country);
CREATE INDEX idx_mv_loc_rollup_region ON public.mv_house_location_rollup (country, region);
CREATE INDEX idx_mv_loc_rollup_district ON public.mv_house_location_rollup (country, region, district);
CREATE INDEX idx_mv_loc_rollup_ward ON public.mv_house_location_rollup (country, region, district, ward);
CREATE INDEX idx_mv_loc_rollup_agent ON public.mv_house_location_rollup (agent_id);
CREATE INDEX idx_mv_loc_rollup_landlord ON public.mv_house_location_rollup (landlord_id);
CREATE INDEX idx_mv_loc_rollup_district_id ON public.mv_house_location_rollup (district_id);
CREATE INDEX idx_mv_loc_rollup_subcounty_id ON public.mv_house_location_rollup (subcounty_id);

GRANT SELECT ON public.mv_house_location_rollup TO authenticated, service_role;

-- 8. Breakdown RPC: id-aware drilldown, additive return columns
DROP FUNCTION IF EXISTS public.get_location_breakdown(text, text, text, text, text, uuid);
CREATE FUNCTION public.get_location_breakdown(
  p_level text,
  p_country text DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_ward text DEFAULT NULL,
  p_agent_id uuid DEFAULT NULL,
  p_district_id integer DEFAULT NULL,
  p_subcounty_id integer DEFAULT NULL
)
RETURNS TABLE(
  key text, label text, agent_id uuid, landlord_id uuid, agent_name text, landlord_name text,
  total integer, occupied integer, vacant integer, hidden integer, revenue_ugx bigint,
  district_id integer, subcounty_id integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_level = 'country' THEN
    RETURN QUERY
    SELECT r.country, r.country, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           SUM(r.total)::int, SUM(r.occupied)::int, SUM(r.vacant)::int, SUM(r.hidden)::int, SUM(r.revenue_ugx)::bigint,
           NULL::int, NULL::int
    FROM mv_house_location_rollup r
    GROUP BY r.country
    ORDER BY SUM(r.total) DESC;

  ELSIF p_level = 'region' THEN
    RETURN QUERY
    SELECT r.region, r.region, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           SUM(r.total)::int, SUM(r.occupied)::int, SUM(r.vacant)::int, SUM(r.hidden)::int, SUM(r.revenue_ugx)::bigint,
           NULL::int, NULL::int
    FROM mv_house_location_rollup r
    WHERE r.country = p_country
    GROUP BY r.region
    ORDER BY SUM(r.total) DESC;

  ELSIF p_level = 'district' THEN
    RETURN QUERY
    SELECT r.district, r.district, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           SUM(r.total)::int, SUM(r.occupied)::int, SUM(r.vacant)::int, SUM(r.hidden)::int, SUM(r.revenue_ugx)::bigint,
           MAX(r.district_id)::int, NULL::int
    FROM mv_house_location_rollup r
    WHERE r.country = p_country AND r.region = p_region
    GROUP BY r.district
    ORDER BY SUM(r.total) DESC;

  ELSIF p_level = 'ward' THEN
    RETURN QUERY
    SELECT r.ward, r.ward, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           SUM(r.total)::int, SUM(r.occupied)::int, SUM(r.vacant)::int, SUM(r.hidden)::int, SUM(r.revenue_ugx)::bigint,
           MAX(r.district_id)::int, MAX(r.subcounty_id)::int
    FROM mv_house_location_rollup r
    WHERE r.country = p_country
      AND (p_district_id IS NOT NULL AND r.district_id = p_district_id
           OR p_district_id IS NULL AND r.region = p_region AND r.district = p_district)
    GROUP BY r.ward
    ORDER BY SUM(r.total) DESC;

  ELSIF p_level = 'agent' THEN
    RETURN QUERY
    SELECT r.agent_id::text, COALESCE(p.full_name, 'Unnamed agent'),
           r.agent_id, NULL::uuid, p.full_name, NULL::text,
           SUM(r.total)::int, SUM(r.occupied)::int, SUM(r.vacant)::int, SUM(r.hidden)::int, SUM(r.revenue_ugx)::bigint,
           MAX(r.district_id)::int, MAX(r.subcounty_id)::int
    FROM mv_house_location_rollup r
    LEFT JOIN profiles p ON p.id = r.agent_id
    WHERE r.country = p_country
      AND (p_district_id IS NOT NULL AND r.district_id = p_district_id
           OR p_district_id IS NULL AND r.region = p_region AND r.district = p_district)
      AND (p_subcounty_id IS NOT NULL AND r.subcounty_id = p_subcounty_id
           OR p_subcounty_id IS NULL AND r.ward = p_ward)
    GROUP BY r.agent_id, p.full_name
    ORDER BY SUM(r.total) DESC;

  ELSIF p_level = 'landlord' THEN
    RETURN QUERY
    SELECT r.landlord_id::text, COALESCE(p.full_name, 'Unnamed landlord'),
           r.agent_id, r.landlord_id, NULL::text, p.full_name,
           SUM(r.total)::int, SUM(r.occupied)::int, SUM(r.vacant)::int, SUM(r.hidden)::int, SUM(r.revenue_ugx)::bigint,
           MAX(r.district_id)::int, MAX(r.subcounty_id)::int
    FROM mv_house_location_rollup r
    LEFT JOIN profiles p ON p.id = r.landlord_id
    WHERE r.country = p_country
      AND (p_district_id IS NOT NULL AND r.district_id = p_district_id
           OR p_district_id IS NULL AND r.region = p_region AND r.district = p_district)
      AND (p_subcounty_id IS NOT NULL AND r.subcounty_id = p_subcounty_id
           OR p_subcounty_id IS NULL AND r.ward = p_ward)
      AND r.agent_id = p_agent_id
    GROUP BY r.landlord_id, r.agent_id, p.full_name
    ORDER BY SUM(r.total) DESC;
  END IF;
END;
$$;

-- 9. Search RPC: additive id columns
DROP FUNCTION IF EXISTS public.search_locations(text, integer);
CREATE FUNCTION public.search_locations(p_query text, p_limit integer DEFAULT 25)
RETURNS TABLE(kind text, label text, country text, region text, district text, ward text,
              agent_id uuid, landlord_id uuid, total integer, district_id integer, subcounty_id integer)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q text := '%' || lower(trim(p_query)) || '%';
BEGIN
  IF p_query IS NULL OR length(trim(p_query)) < 2 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT 'country', r.country, r.country, NULL::text, NULL::text, NULL::text, NULL::uuid, NULL::uuid, SUM(r.total)::int, NULL::int, NULL::int
  FROM mv_house_location_rollup r
  WHERE lower(r.country) LIKE q
  GROUP BY r.country
  UNION ALL
  SELECT 'region', r.region || ', ' || r.country, r.country, r.region, NULL::text, NULL::text, NULL::uuid, NULL::uuid, SUM(r.total)::int, NULL::int, NULL::int
  FROM mv_house_location_rollup r
  WHERE lower(r.region) LIKE q
  GROUP BY r.country, r.region
  UNION ALL
  SELECT 'district', r.district || ', ' || r.region, r.country, r.region, r.district, NULL::text, NULL::uuid, NULL::uuid, SUM(r.total)::int, MAX(r.district_id)::int, NULL::int
  FROM mv_house_location_rollup r
  WHERE lower(r.district) LIKE q
  GROUP BY r.country, r.region, r.district
  UNION ALL
  SELECT 'ward', r.ward || ', ' || r.district, r.country, r.region, r.district, r.ward, NULL::uuid, NULL::uuid, SUM(r.total)::int, MAX(r.district_id)::int, MAX(r.subcounty_id)::int
  FROM mv_house_location_rollup r
  WHERE lower(r.ward) LIKE q
  GROUP BY r.country, r.region, r.district, r.ward
  UNION ALL
  SELECT 'agent', COALESCE(p.full_name,'Unnamed agent'), NULL::text, NULL::text, NULL::text, NULL::text, p.id, NULL::uuid, COALESCE(SUM(r.total),0)::int, NULL::int, NULL::int
  FROM profiles p
  LEFT JOIN mv_house_location_rollup r ON r.agent_id = p.id
  WHERE lower(COALESCE(p.full_name,'')) LIKE q OR lower(COALESCE(p.phone,'')) LIKE q
  GROUP BY p.id, p.full_name
  HAVING COALESCE(SUM(r.total),0) > 0
  UNION ALL
  SELECT 'landlord', COALESCE(p.full_name,'Unnamed landlord'), NULL::text, NULL::text, NULL::text, NULL::text, NULL::uuid, p.id, COALESCE(SUM(r.total),0)::int, NULL::int, NULL::int
  FROM profiles p
  LEFT JOIN mv_house_location_rollup r ON r.landlord_id = p.id
  WHERE lower(COALESCE(p.full_name,'')) LIKE q OR lower(COALESCE(p.phone,'')) LIKE q
  GROUP BY p.id, p.full_name
  HAVING COALESCE(SUM(r.total),0) > 0
  ORDER BY 9 DESC NULLS LAST
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_location_breakdown(text, text, text, text, text, uuid, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_locations(text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.refresh_ug_geo_alias() TO service_role;