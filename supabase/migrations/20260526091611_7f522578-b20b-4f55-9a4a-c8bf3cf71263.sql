
-- =====================================================================
-- Geographic coverage RPCs for Tenant Ops "Geographic Coverage" panel
-- =====================================================================

-- Helper: caller-allowed check (reuses has_role)
CREATE OR REPLACE FUNCTION public._geo_coverage_caller_allowed()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'operations')
    OR public.has_role(auth.uid(), 'agent');
$$;

-- Normalize helper (trim + initcap of lower)
CREATE OR REPLACE FUNCTION public._geo_norm(p text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT NULLIF(initcap(lower(btrim(p))), '');
$$;

-- ---------------------------------------------------------------------
-- Aggregate counts grouped by next level below the supplied filters.
-- Filter args are case-insensitive; pass NULL to roll up at top level.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_geo_user_coverage(
  p_country  text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_city     text DEFAULT NULL
)
RETURNS TABLE (
  level             text,      -- 'country' | 'district' | 'city'
  bucket            text,      -- the value of the next level
  tenants           bigint,
  landlords         bigint,
  funders           bigint,
  agents            bigint,
  funded_tenants    bigint     -- tenants whose landlord got a Welile disbursement
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_country  text := public._geo_norm(p_country);
  v_district text := public._geo_norm(p_district);
  v_city     text := public._geo_norm(p_city);
  v_level    text;
BEGIN
  IF NOT public._geo_coverage_caller_allowed() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  v_level := CASE
    WHEN v_country IS NULL  THEN 'country'
    WHEN v_district IS NULL THEN 'district'
    ELSE 'city'
  END;

  RETURN QUERY
  WITH
  -- ---------- USERS (tenants / funders / agents come from user_roles + profiles) ----------
  user_geo AS (
    SELECT
      ur.role::text                      AS role,
      public._geo_norm(p.country)        AS country,
      public._geo_norm(p.district)       AS district,
      COALESCE(public._geo_norm(p.city), public._geo_norm(p.town_council)) AS city,
      p.id                               AS user_id
    FROM public.user_roles ur
    JOIN public.profiles  p ON p.id = ur.user_id
    WHERE ur.role IN ('tenant','supporter','agent')
  ),
  -- ---------- LANDLORDS (own table, may or may not be platform users) ----------
  landlord_geo AS (
    SELECT
      public._geo_norm(l.country)  AS country,
      public._geo_norm(l.district) AS district,
      public._geo_norm(l.city)     AS city,
      l.id                         AS landlord_id
    FROM public.landlords l
  ),
  -- ---------- FUNDED LANDLORDS (any rent_request that paid the landlord) ----------
  funded_landlord_ids AS (
    SELECT DISTINCT rr.landlord_id
    FROM public.rent_requests rr
    WHERE rr.landlord_id IS NOT NULL
      AND rr.status IN ('funded','repaying','completed')
  ),
  -- ---------- TENANTS whose landlord was funded ----------
  funded_tenant_geo AS (
    SELECT DISTINCT
      rr.tenant_id,
      public._geo_norm(p.country)  AS country,
      public._geo_norm(p.district) AS district,
      COALESCE(public._geo_norm(p.city), public._geo_norm(p.town_council)) AS city
    FROM public.rent_requests rr
    JOIN public.profiles p ON p.id = rr.tenant_id
    WHERE rr.landlord_id IN (SELECT landlord_id FROM funded_landlord_ids)
  )
  SELECT
    v_level                                                  AS level,
    bucket,
    COALESCE(SUM(CASE WHEN src='tenant'   THEN 1 END), 0)::bigint AS tenants,
    COALESCE(SUM(CASE WHEN src='landlord' THEN 1 END), 0)::bigint AS landlords,
    COALESCE(SUM(CASE WHEN src='funder'   THEN 1 END), 0)::bigint AS funders,
    COALESCE(SUM(CASE WHEN src='agent'    THEN 1 END), 0)::bigint AS agents,
    COALESCE(SUM(CASE WHEN src='funded_tenant' THEN 1 END), 0)::bigint AS funded_tenants
  FROM (
    -- users
    SELECT
      CASE ug.role WHEN 'tenant' THEN 'tenant'
                   WHEN 'supporter' THEN 'funder'
                   WHEN 'agent' THEN 'agent' END AS src,
      CASE v_level
        WHEN 'country'  THEN COALESCE(ug.country, 'Unknown')
        WHEN 'district' THEN COALESCE(ug.district, 'Unknown')
        ELSE                  COALESCE(ug.city, 'Unknown')
      END AS bucket
    FROM user_geo ug
    WHERE (v_country  IS NULL OR ug.country  = v_country)
      AND (v_district IS NULL OR ug.district = v_district)
      AND (v_city     IS NULL OR ug.city     = v_city)

    UNION ALL
    -- landlords
    SELECT
      'landlord' AS src,
      CASE v_level
        WHEN 'country'  THEN COALESCE(lg.country, 'Unknown')
        WHEN 'district' THEN COALESCE(lg.district, 'Unknown')
        ELSE                  COALESCE(lg.city, 'Unknown')
      END AS bucket
    FROM landlord_geo lg
    WHERE (v_country  IS NULL OR lg.country  = v_country)
      AND (v_district IS NULL OR lg.district = v_district)
      AND (v_city     IS NULL OR lg.city     = v_city)

    UNION ALL
    -- funded tenants
    SELECT
      'funded_tenant' AS src,
      CASE v_level
        WHEN 'country'  THEN COALESCE(ft.country, 'Unknown')
        WHEN 'district' THEN COALESCE(ft.district, 'Unknown')
        ELSE                  COALESCE(ft.city, 'Unknown')
      END AS bucket
    FROM funded_tenant_geo ft
    WHERE (v_country  IS NULL OR ft.country  = v_country)
      AND (v_district IS NULL OR ft.district = v_district)
      AND (v_city     IS NULL OR ft.city     = v_city)
  ) src
  GROUP BY bucket
  ORDER BY bucket;
END;
$$;

-- ---------------------------------------------------------------------
-- Drill-through: tenants whose landlord was funded, at a given scope.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_funded_tenants_at(
  p_country  text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_city     text DEFAULT NULL,
  p_limit    int  DEFAULT 200,
  p_offset   int  DEFAULT 0
)
RETURNS TABLE (
  tenant_id        uuid,
  tenant_name      text,
  tenant_phone     text,
  tenant_country   text,
  tenant_district  text,
  tenant_city      text,
  landlord_id      uuid,
  landlord_name    text,
  latest_status    text,
  latest_rent_amount numeric,
  rent_request_id  uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_country  text := public._geo_norm(p_country);
  v_district text := public._geo_norm(p_district);
  v_city     text := public._geo_norm(p_city);
BEGIN
  IF NOT public._geo_coverage_caller_allowed() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH funded_rr AS (
    SELECT DISTINCT ON (rr.tenant_id, rr.landlord_id)
      rr.id, rr.tenant_id, rr.landlord_id, rr.status, rr.rent_amount, rr.created_at
    FROM public.rent_requests rr
    WHERE rr.tenant_id IS NOT NULL
      AND rr.landlord_id IS NOT NULL
      AND rr.status IN ('funded','repaying','completed')
    ORDER BY rr.tenant_id, rr.landlord_id, rr.created_at DESC
  )
  SELECT
    p.id                                                   AS tenant_id,
    p.full_name                                            AS tenant_name,
    p.phone                                                AS tenant_phone,
    public._geo_norm(p.country)                            AS tenant_country,
    public._geo_norm(p.district)                           AS tenant_district,
    COALESCE(public._geo_norm(p.city), public._geo_norm(p.town_council)) AS tenant_city,
    l.id                                                   AS landlord_id,
    l.name                                                 AS landlord_name,
    fr.status                                              AS latest_status,
    fr.rent_amount                                         AS latest_rent_amount,
    fr.id                                                  AS rent_request_id
  FROM funded_rr fr
  JOIN public.profiles  p ON p.id = fr.tenant_id
  LEFT JOIN public.landlords l ON l.id = fr.landlord_id
  WHERE (v_country  IS NULL OR public._geo_norm(p.country)  = v_country)
    AND (v_district IS NULL OR public._geo_norm(p.district) = v_district)
    AND (v_city     IS NULL OR COALESCE(public._geo_norm(p.city), public._geo_norm(p.town_council)) = v_city)
  ORDER BY fr.created_at DESC
  LIMIT GREATEST(1, LEAST(p_limit, 1000))
  OFFSET GREATEST(0, p_offset);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_geo_user_coverage(text,text,text)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_funded_tenants_at(text,text,text,int,int) TO authenticated;
